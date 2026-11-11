import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
	type Hook,
	Hooks,
	commentDetails,
	commitDetails,
	compileEndDetails,
	headCommitDetails,
	hookFailedNotice,
	hooksFor,
	pushDetails,
	runHook,
	savedHooks,
	type HookPayload,
} from "../src/hooks";
import type { CompileReport } from "../src/compile";
import { PUSH_REJECTED } from "../src/push";
import { commitFiles, initRepo, tempFolder } from "./helpers";

const payload: HookPayload = { event: "commit", vault: "Model", author: "Ada", time: "2026-01-01T00:00:00.000Z", details: { hash: "abc" } };

function context(dir: string, hooks: Hook[], failed: string[] = []) {
	return new Hooks({
		hooks: () => hooks,
		vaultPath: () => dir,
		vaultName: () => "Model",
		author: async () => "Ada",
		failed: (notice) => failed.push(notice),
		now: () => new Date("2026-01-01T00:00:00Z"),
	});
}

describe("hooks", () => {
	it("are kept in plugin data and start empty (HOOK-8)", () => {
		expect(savedHooks([{ event: "push", command: "echo" }, { event: "nope", command: "x" }, null, { event: "commit" }])).toEqual([
			{ event: "push", command: "echo" },
		]);
		expect(savedHooks(undefined)).toEqual([]);
	});

	it("run only for their own event, and only with a command (HOOK-1)", () => {
		const hooks: Hook[] = [
			{ event: "push", command: "a" },
			{ event: "commit", command: "b" },
			{ event: "push", command: "  " },
		];
		expect(hooksFor(hooks, "push")).toEqual([{ event: "push", command: "a" }]);
	});

	it("get the event as JSON on stdin, in the vault folder (HOOK-3, HOOK-5)", async () => {
		const dir = tempFolder();
		const result = await runHook("cat > got.json; pwd > cwd.txt", payload, dir);
		expect(result).toEqual({ ok: true });
		expect(JSON.parse(readFileSync(join(dir, "got.json"), "utf8"))).toEqual(payload);
		expect(readFileSync(join(dir, "cwd.txt"), "utf8").trim()).toBe(dir);
	});

	it("run with the plugin's tool PATH (HOOK-5)", async () => {
		const dir = tempFolder();
		await runHook('printf %s "$PATH" > path.txt', payload, dir);
		const path = readFileSync(join(dir, "path.txt"), "utf8");
		expect(path).toContain("/usr/bin");
		expect(path).toContain("theory-test-bin-");
	});

	it("say why they failed", async () => {
		const dir = tempFolder();
		expect(await runHook("echo 'no webhook' >&2; exit 3", payload, dir)).toEqual({ ok: false, reason: "no webhook" });
		expect(await runHook("exit 4", payload, dir)).toEqual({ ok: false, reason: "exited with code 4" });
		expect(await runHook("true", payload, dir)).toEqual({ ok: true });
	});

	it("are stopped after the time limit (HOOK-6)", async () => {
		const dir = tempFolder();
		const started = Date.now();
		const result = await runHook("sleep 5", payload, dir, 300);
		expect(result).toEqual({ ok: false, reason: "timed out after 0.3 seconds" });
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it("never delay what triggered them, and show a notice when they fail (HOOK-4, HOOK-7)", async () => {
		const dir = tempFolder();
		const failed: string[] = [];
		const hooks = context(dir, [{ event: "push", command: "sleep 1; echo broken >&2; exit 1" }], failed);
		const started = Date.now();
		hooks.fire("push", { status: "pushed" });
		expect(Date.now() - started).toBeLessThan(200);
		expect(failed).toEqual([]);
		await new Promise((resolve) => setTimeout(resolve, 2000));
		expect(failed).toEqual(["Hook for push failed: broken"]);
	});

	it("send the vault, author, time and details", async () => {
		const dir = tempFolder();
		const hooks = context(dir, [{ event: "commit", command: "cat > got.json" }]);
		await hooks.runAll(hooksFor([{ event: "commit", command: "cat > got.json" }], "commit"), "commit", { hash: "abc" });
		expect(JSON.parse(readFileSync(join(dir, "got.json"), "utf8"))).toEqual(payload);
	});

	it("Test sends a sample event (HOOK-9)", async () => {
		const dir = tempFolder();
		const hooks = context(dir, []);
		const result = await hooks.test({ event: "compile-end", command: "cat > got.json" });
		expect(result).toEqual({ ok: true });
		const got = JSON.parse(readFileSync(join(dir, "got.json"), "utf8"));
		expect(got.event).toBe("compile-end");
		expect(got.details).toMatchObject({ status: "succeeded", questions: 0, sample: true });
	});

	it("name the event in the failure notice (HOOK-7)", () => {
		expect(hookFailedNotice("compile-end", "timed out")).toBe("Hook for compile-end failed: timed out");
	});
});

describe("hook details (HOOK-3)", () => {
	const file = {
		version: 1 as const,
		note: "A.md",
		threads: [{ id: "t1", anchor: { quote: "q" }, comments: [{ id: "c1", text: "Why?", by: { name: "A", email: "a@x" }, at: "" }], resolved: null }],
	} as never;

	it("give the note and comment text", () => {
		expect(commentDetails("A.md", { kind: "comment", anchor: { quote: "q" } as never, text: "Hi" }, file)).toEqual({
			action: "comment",
			note: "A.md",
			text: "Hi",
		});
		expect(commentDetails("A.md", { kind: "reply", threadId: "t1", text: "Yes" }, file)).toEqual({
			action: "reply",
			note: "A.md",
			text: "Yes",
			thread: "t1",
		});
		expect(commentDetails("A.md", { kind: "resolve", threadId: "t1" }, file)).toEqual({
			action: "resolve",
			note: "A.md",
			text: "Why?",
			thread: "t1",
		});
	});

	it("give the commit hash and subject", async () => {
		expect(commitDetails("abc1234", "Add rules\n\nBody")).toEqual({ hash: "abc1234", subject: "Add rules" });
		const repo = join(tempFolder(), "vault");
		await initRepo(repo);
		await commitFiles(repo, { "B.md": "b\n" }, "Add B");
		const details = await headCommitDetails(repo);
		expect(details.subject).toBe("Add B");
		expect(details.hash).toMatch(/^[0-9a-f]{7,}$/);
	});

	it("give the push as pushed or failed, and nothing without a remote", () => {
		expect(pushDetails({ kind: "pushed" })).toEqual({ status: "pushed" });
		expect(pushDetails({ kind: "rejected" })).toEqual({ status: "failed", message: PUSH_REJECTED });
		expect(pushDetails({ kind: "failed", message: "denied" })).toEqual({ status: "failed", message: "denied" });
		expect(pushDetails({ kind: "no-origin" })).toBeNull();
	});

	it("give the compile status, summary and number of questions", () => {
		const report = { status: "cancelled", summary: "Stopped", questions: [{}, {}] } as unknown as CompileReport;
		expect(compileEndDetails(report)).toEqual({ status: "cancelled", summary: "Stopped", questions: 2 });
	});
});
