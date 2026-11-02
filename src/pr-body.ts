import { ChildProcess, spawn } from "child_process";
import { tmpdir } from "os";
import type { CompileEffort, CompileModel, CompileReport } from "./compile";
import { TOOL_PATH } from "./vault";

export interface PullRequestBodyOptions {
	claudeCommand: string;
	model: CompileModel;
	effort: CompileEffort;
	report: CompileReport;
	/** The repositories the body is for: one for a repository's own body, all of them for the shared body. */
	repos: string[];
	/** True when the project folder has several repositories, so changes start with "[repo]". */
	several: boolean;
}

export interface PullRequestBodyRun {
	done: Promise<string>;
	cancel(): void;
}

/** The changes for these repositories. With one repository, every change is about it. */
function changesFor(report: CompileReport, repos: string[], several: boolean): string[] {
	if (!several) return report.changes;
	return report.changes.filter((change) => repos.some((repo) => change.startsWith(`[${repo}]`)));
}

/** Everything Claude gets: the compile's summary, revisions, open problems and questions, and the changes. */
function buildPrompt(options: PullRequestBodyOptions): string {
	const { report, repos, several } = options;
	const list = (items: string[]) => (items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "(none)");
	return `Write the body of a GitHub pull request for code changes that a compile made from a theoretical model: notes, written by humans, that describe a software system.

You have no tools; everything you may use is below.

Rules:
- Reply with the body only, in GitHub Markdown. No preamble and no code fence around it.
- Say what changed and why, drawn only from what is below. Don't invent anything.
- Mention open problems and questions so a reviewer knows what is unfinished.

## Repositories

${list(repos)}

## Compile summary

${report.summary || "(none)"}

## Revisions of the model compiled

${list(report.revisions.map((r) => `${r.hash.slice(0, 7)} ${r.subject} (${r.author})`))}

## Changes to the code

${list(changesFor(report, repos, several))}

## Problems still open

${list(report.problems.map((p) => p.text))}

## Questions about the model still open

${list(report.questions.map((q) => q.question))}
`;
}

/**
 * Asks Claude Code for a pull request body with no tools, so generating it never changes code or model.
 * It runs outside the vault and the project folder.
 */
export function generatePullRequestBody(options: PullRequestBodyOptions): PullRequestBodyRun {
	const args = ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence"];
	if (options.model) args.push("--model", options.model);
	if (options.effort) args.push("--effort", options.effort);

	let child: ChildProcess | null = null;
	let cancelled = false;
	const done = new Promise<string>((resolve, reject) => {
		try {
			child = spawn(options.claudeCommand || "claude", args, { cwd: tmpdir(), env: { ...process.env, PATH: TOOL_PATH } });
		} catch (error) {
			reject(error);
			return;
		}
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => (stdout += chunk));
		child.stderr?.on("data", (chunk) => (stderr += chunk));
		child.stdin?.on("error", () => {});
		child.on("error", (error) =>
			reject(
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? new Error(`Couldn't find the Claude Code CLI ("${options.claudeCommand}"). Set its path in theory.md settings.`)
					: error,
			),
		);
		child.on("close", (code) => {
			if (cancelled) return reject(new Error("cancelled"));
			let result: { is_error?: boolean; result?: unknown } | null = null;
			try {
				result = JSON.parse(stdout);
			} catch {
				// Handled below.
			}
			const text = typeof result?.result === "string" ? result.result.trim() : "";
			if (!result || result.is_error || !text) {
				return reject(new Error(text || stderr.trim() || `Claude Code exited with code ${code}.`));
			}
			const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text);
			resolve(fenced ? fenced[1].trim() : text);
		});
		// Keeps the prompt out of the argument list, which has a size limit.
		child.stdin?.end(buildPrompt(options));
	});

	return {
		done,
		cancel() {
			cancelled = true;
			child?.kill("SIGTERM");
		},
	};
}
