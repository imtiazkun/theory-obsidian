import { ChildProcess, spawn } from "child_process";
import { tmpdir } from "os";
import type { Anchor } from "./anchor";
import type { CompileEffort, CompileModel, Question } from "./compile";
import { toolPath } from "./tool-path";

/** Ideation for the engineer, shown on screen only. It is never model text and is never saved. */
export interface Suggestion {
	/** The text Claude suggests for the note. The engineer may edit it before Accept. */
	text: string;
	/** One sentence on why. */
	why: string;
}

export interface SuggestOptions {
	claudeCommand: string;
	model: CompileModel;
	effort: CompileEffort;
	question: Question;
	/** The compile's summary. */
	summary: string;
	/** The current text of every note the question names, uncommitted edits included, keyed by path. */
	notes: Map<string, string | null>;
}

export interface SuggestRun {
	done: Promise<Suggestion>;
	cancel(): void;
}

function anchorText(anchor: Anchor): string {
	const parts = [`- ${anchor.path}`];
	if (anchor.heading) parts.push(`under "${anchor.heading}"`);
	if (anchor.quote) parts.push(`at: ${anchor.quote}`);
	return parts.join(", ");
}

/** The whole context Claude gets: the question, its anchors, the notes it names and the compile's summary. */
function buildPrompt(options: SuggestOptions): string {
	const { question, summary, notes } = options;
	const anchors = question.anchors?.length ? question.anchors.map(anchorText).join("\n") : "(none)";
	const noteText = [...notes]
		.map(([path, text]) => `### ${path}\n\n${text === null ? "(This note doesn't exist.)" : text}`)
		.join("\n\n");
	return `An engineer writes a theoretical model of a software system as notes. A compile turned the model into code and asked the engineer a question about the model. Suggest how the engineer could change the note to answer it.

Your suggestion is ideation only. The engineer will write the note in their own words. You have no tools; everything you may use is below.

Reply with only a JSON object, no other text: {"text": "<the text you suggest for the note>", "why": "<one sentence on why>"}. When you can't suggest anything, reply {"text": "", "why": "<the reason>"}.

## Question

${question.question}

## Where in the model it is about

${anchors}

## Compile summary

${summary || "(none)"}

## Notes the question names, as they are now

${noteText || "(none)"}
`;
}

/** Pulls the suggestion out of Claude's reply, which may wrap the JSON in a code fence. */
function parseSuggestion(text: string): Suggestion {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error("Claude didn't reply with a suggestion.");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		throw new Error("Claude's reply couldn't be read.");
	}
	const { text: suggested, why } = (parsed ?? {}) as Record<string, unknown>;
	const reason = typeof why === "string" ? why.trim() : "";
	if (typeof suggested !== "string" || !suggested.trim()) throw new Error(reason || "Claude gave no suggestion.");
	return { text: suggested.trim(), why: reason };
}

/**
 * Asks Claude Code for a suggestion with no tools, so it reads nothing beyond the context
 * given and writes nothing. It runs outside the vault and the project folder.
 */
export function startSuggest(options: SuggestOptions): SuggestRun {
	const args = [
		"-p",
		"--output-format",
		"json",
		"--tools",
		"",
		"--strict-mcp-config",
		"--no-session-persistence",
	];
	if (options.model) args.push("--model", options.model);
	if (options.effort) args.push("--effort", options.effort);

	let child: ChildProcess | null = null;
	let cancelled = false;
	const done = new Promise<Suggestion>((resolve, reject) => {
		try {
			child = spawn(options.claudeCommand || "claude", args, {
				cwd: tmpdir(),
				env: { ...process.env, PATH: toolPath() },
			});
		} catch (error) {
			reject(error);
			return;
		}
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => (stdout += chunk));
		child.stderr?.on("data", (chunk) => (stderr += chunk));
		child.stdin?.on("error", () => {});
		child.on("error", (error) => {
			reject(
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? new Error(`couldn't find the Claude Code CLI ("${options.claudeCommand}")`)
					: error,
			);
		});
		child.on("close", (code) => {
			if (cancelled) return reject(new Error("cancelled"));
			let result: { is_error?: boolean; result?: unknown } | null = null;
			try {
				result = JSON.parse(stdout);
			} catch {
				// Handled below.
			}
			const text = typeof result?.result === "string" ? result.result : "";
			if (!result || result.is_error) {
				return reject(new Error(text || stderr.trim() || `Claude Code exited with code ${code}`));
			}
			try {
				resolve(parseSuggestion(text));
			} catch (error) {
				reject(error);
			}
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
