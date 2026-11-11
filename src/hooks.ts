import { spawn } from "child_process";
import type { CommentAction, CommentFile } from "./comments";
import type { CompileReport, PermissionRequest } from "./compile";
import { PUSH_REJECTED, type PushResult } from "./push";
import { toolPath } from "./tool-path";
import { git } from "./vault";

/** The events a hook can be tied to (HOOK-2). */
export const HOOK_EVENTS = ["comment", "commit", "push", "compile-start", "compile-end", "permission-request"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** What each event means, for the settings. */
export const HOOK_EVENT_NAMES: Record<HookEvent, string> = {
	comment: "Comment committed",
	commit: "Revision committed",
	push: "Push finished",
	"compile-start": "Compile started",
	"compile-end": "Compile ended",
	"permission-request": "Permission requested",
};

/** One hook: a shell command tied to one event (HOOK-1). Lives in plugin data, never in the vault (HOOK-8). */
export interface Hook {
	event: HookEvent;
	command: string;
}

/** The JSON a hook gets on stdin (HOOK-3). */
export interface HookPayload {
	event: HookEvent;
	vault: string;
	author: string;
	time: string;
	details: Record<string, unknown>;
}

/** A hook gets at most this long, then it is stopped (HOOK-6). */
export const HOOK_TIMEOUT_MS = 10_000;

export type HookResult = { ok: true } | { ok: false; reason: string };

/** The notice for a hook that failed or timed out (HOOK-7). */
export function hookFailedNotice(event: HookEvent, reason: string): string {
	return `Hook for ${event} failed: ${reason}`;
}

export function isHookEvent(value: unknown): value is HookEvent {
	return typeof value === "string" && (HOOK_EVENTS as readonly string[]).includes(value);
}

/** The hooks kept from saved plugin data, dropping anything that isn't a hook. */
export function savedHooks(value: unknown): Hook[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((h): h is Hook => !!h && isHookEvent((h as Hook).event) && typeof (h as Hook).command === "string")
		.map((h) => ({ event: h.event, command: h.command }));
}

/** The hooks that run for `event`: those tied to it with a command. */
export function hooksFor(hooks: Hook[], event: HookEvent): Hook[] {
	return hooks.filter((hook) => hook.event === event && hook.command.trim() !== "");
}

/**
 * Runs `command` in a shell in `cwd`, with the login PATH (HOOK-5) and `payload` as JSON on stdin (HOOK-3).
 * Stopped after `timeoutMs` (HOOK-6). Never throws.
 */
export function runHook(command: string, payload: HookPayload, cwd: string, timeoutMs = HOOK_TIMEOUT_MS): Promise<HookResult> {
	return new Promise((resolve) => {
		let done = false;
		let stderr = "";
		const finish = (result: HookResult) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(result);
		};
		let child: ReturnType<typeof spawn>;
		try {
			// Its own process group, so a timeout stops the commands the shell started too.
			child = spawn("/bin/sh", ["-c", command], {
				cwd,
				env: { ...process.env, PATH: toolPath() },
				stdio: ["pipe", "ignore", "pipe"],
				detached: true,
			});
		} catch (error) {
			resolve({ ok: false, reason: error instanceof Error ? error.message : String(error) });
			return;
		}
		const timer = setTimeout(() => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
			finish({ ok: false, reason: `timed out after ${timeoutMs / 1000} seconds` });
		}, timeoutMs);
		child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.on("error", (error) => finish({ ok: false, reason: error.message }));
		child.on("close", (code, signal) => {
			if (code === 0) return finish({ ok: true });
			const lastLine = stderr.trim().split("\n").pop()?.trim();
			finish({ ok: false, reason: lastLine || (signal ? `stopped by ${signal}` : `exited with code ${code}`) });
		});
		// A hook that doesn't read stdin must not fail on a closed pipe.
		child.stdin?.on("error", () => {});
		child.stdin?.end(JSON.stringify(payload) + "\n");
	});
}

export interface HookContext {
	hooks: () => Hook[];
	vaultPath: () => string;
	vaultName: () => string;
	author: () => Promise<string>;
	failed: (notice: string) => void;
	now?: () => Date;
}

/**
 * Runs the hooks for an event after it happened (HOOK-4). `fire` returns at once and never throws, so a
 * hook never stops, changes or delays what triggered it. A failed hook shows a notice (HOOK-7).
 */
export class Hooks {
	constructor(private context: HookContext) {}

	/** Starts every hook tied to `event`. Returns at once. */
	fire(event: HookEvent, details: Record<string, unknown>): void {
		const hooks = hooksFor(this.context.hooks(), event);
		if (hooks.length === 0) return;
		void this.runAll(hooks, event, details).catch(() => {});
	}

	/** Runs every hook in `hooks` and waits for them. Used by `fire` and tests. */
	async runAll(hooks: Hook[], event: HookEvent, details: Record<string, unknown>): Promise<HookResult[]> {
		const payload = await this.payload(event, details);
		let cwd: string;
		try {
			cwd = this.context.vaultPath();
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			for (let i = 0; i < hooks.length; i++) this.context.failed(hookFailedNotice(event, reason));
			return hooks.map(() => ({ ok: false, reason }));
		}
		return Promise.all(
			hooks.map(async (hook) => {
				const result = await runHook(hook.command, payload, cwd);
				if (!result.ok) this.context.failed(hookFailedNotice(event, result.reason));
				return result;
			}),
		);
	}

	/** Sends one hook a sample event (HOOK-9). */
	test(hook: Hook): Promise<HookResult> {
		return this.runAll([hook], hook.event, { ...sampleDetails(hook.event), sample: true }).then((results) => results[0]);
	}

	private async payload(event: HookEvent, details: Record<string, unknown>): Promise<HookPayload> {
		let vault = "";
		let author = "";
		try {
			vault = this.context.vaultName();
		} catch {
			// The name is only for the hook's message.
		}
		try {
			author = await this.context.author();
		} catch {
			// A hook still runs when git can't say who the author is.
		}
		const now = this.context.now?.() ?? new Date();
		return { event, vault, author, time: now.toISOString(), details };
	}
}

/** The details of a sample event for the Test button (HOOK-9). */
export function sampleDetails(event: HookEvent): Record<string, unknown> {
	switch (event) {
		case "comment":
			return { action: "comment", note: "Example.md", text: "This is a sample comment." };
		case "commit":
			return { hash: "0000000", subject: "Sample revision" };
		case "push":
			return { status: "pushed" };
		case "compile-start":
			return { status: "running", revisions: 1 };
		case "compile-end":
			return { status: "succeeded", summary: "A sample compile.", questions: 0 };
		case "permission-request":
			return { tool: "Bash", target: "npm test", reason: "A sample request." };
	}
}

/** The details of a `comment` event: the note, what was done and the comment's text (HOOK-3). */
export function commentDetails(notePath: string, action: CommentAction, file: CommentFile): Record<string, unknown> {
	const details: Record<string, unknown> = { action: action.kind, note: notePath };
	if (action.kind === "comment" || action.kind === "reply") {
		details.text = action.text;
		if (action.kind === "reply") details.thread = action.threadId;
	} else {
		// Resolve and reopen carry no text of their own: the thread's first comment says what it is about.
		const thread = file.threads.find((t) => t.id === action.threadId);
		details.thread = action.threadId;
		details.text = thread?.comments[0]?.text ?? "";
	}
	return details;
}

/** The details of a `commit` event: the short hash and the subject (HOOK-3). */
export function commitDetails(hash: string, message: string): Record<string, unknown> {
	return { hash, subject: message.split("\n")[0].trim() };
}

/** The details of a `push` event: pushed or failed, with the reason (HOOK-2). Null when nothing was pushed (no remote). */
export function pushDetails(result: PushResult): Record<string, unknown> | null {
	switch (result.kind) {
		case "no-origin":
			return null;
		case "pushed":
			return { status: "pushed" };
		case "rejected":
			return { status: "failed", message: PUSH_REJECTED };
		case "failed":
			return { status: "failed", message: result.message };
	}
}

/** The details of a `compile-end` event: the status, the summary and the number of questions (HOOK-3). */
export function compileEndDetails(report: CompileReport): Record<string, unknown> {
	return { status: report.status, summary: report.summary, questions: report.questions.length };
}

/** The details of a `permission-request` event: the tool, the exact command or file, and the reason. */
export function permissionDetails(request: PermissionRequest): Record<string, unknown> {
	return { tool: request.tool, target: request.target, reason: request.reason };
}

/** The details of the vault's newest commit, for commits made outside the Commit page. */
export async function headCommitDetails(vaultPath: string): Promise<Record<string, unknown>> {
	const { stdout } = await git(vaultPath, ["log", "-1", "--format=%h%n%s"]);
	const [hash, subject = ""] = stdout.trim().split("\n");
	return { hash, subject };
}
