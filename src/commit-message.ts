import { spawn } from "child_process";
import { tmpdir } from "os";
import { NOT_SENT } from "./compile";
import { TOOL_PATH, uncommittedDiff } from "./vault";

// Enough for Claude to see what changed, small enough to answer quickly.
const MAX_DIFF_CHARS = 50_000;

function buildPrompt(diff: string): string {
	return `Write a git commit message for these uncommitted changes to a theoretical model: Markdown notes, written by humans, that describe a piece of software.

Rules:
- Reply with the commit message only. No preamble, no quotes, no code fence.
- The first line is a short subject in the imperative, under 72 characters.
- When the changes show why they were made, add a blank line and one or two sentences saying why.
- Describe only what the diff shows. Don't invent reasons.

\`\`\`diff
${diff}
\`\`\`
`;
}

/** Strips a code fence or quotes Claude may wrap the message in. */
function cleanMessage(text: string): string {
	let message = text.trim();
	const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(message);
	if (fenced) message = fenced[1].trim();
	if (/^"[\s\S]*"$/.test(message)) message = message.slice(1, -1).trim();
	return message;
}

/**
 * Asks Claude Code for a commit message describing the uncommitted changes to `paths`.
 * Claude gets no tools and runs outside the vault, so it can only read the diff it's given.
 * Files never sent to Claude in a compile are left out here too.
 */
export async function generateCommitMessage(
	vaultPath: string,
	paths: string[],
	claudeCommand: string,
): Promise<string> {
	let diff = await uncommittedDiff(vaultPath, paths, NOT_SENT);
	if (diff.trim() === "") throw new Error("None of these changes may be sent to Claude.");
	if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS) + "\n\n[Diff cut short.]\n";

	const vault = vaultPath.replace(/^\//, "");
	const args = [
		"-p",
		"--output-format",
		"json",
		"--no-session-persistence",
		"--tools",
		"",
		"--disallowedTools",
		...["Edit", "Write", "NotebookEdit"].map((tool) => `${tool}(//${vault}/**)`),
	];

	const output = await new Promise<string>((resolve, reject) => {
		const child = spawn(claudeCommand || "claude", args, { cwd: tmpdir(), env: { ...process.env, PATH: TOOL_PATH } });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", (error) =>
			reject(
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? new Error(`Couldn't find the Claude Code CLI ("${claudeCommand}"). Set its path in theory.md settings.`)
					: error,
			),
		);
		child.on("close", (code) =>
			code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `Claude Code exited with code ${code}.`)),
		);
		// Keeps the diff out of the argument list, which has a size limit.
		child.stdin.end(buildPrompt(diff));
	});

	let result: { is_error?: boolean; result?: unknown };
	try {
		result = JSON.parse(output);
	} catch {
		throw new Error("Claude Code didn't answer in the expected format.");
	}
	const message = typeof result.result === "string" ? cleanMessage(result.result) : "";
	if (result.is_error || !message) throw new Error(message || "Claude Code didn't write a message.");
	return message;
}
