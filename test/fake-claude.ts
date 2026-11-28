import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { git } from "../src/vault";
import { initRepo, tempFolder, write } from "./helpers";

/** What the fake Claude Code does on one run, in the order it is started. */
export interface FakeStep {
	/** Writes this file in the folder it runs in, and commits it there, like Claude building an issue. */
	commit?: string;
	/** Switches to another branch before answering, which Claude must never do. */
	checkout?: string;
	/** Records every file in the folder it runs in, relative to it, in its call (`files`). */
	listFiles?: boolean;
	/** Makes this file's folder writable and writes the file, relative to the folder it runs in, as an agent's own shell could. */
	tamper?: string;
	/** Waits until it is stopped, so a test can cancel it. */
	hang?: boolean;
	/** The structured answer. Without one, it answers with no structured output. */
	answer?: unknown;
	/** The model it says it runs, in the `system` `init` event Claude Code sends first. Unset sends no such event. */
	model?: string;
	/** The `usage` of its result. Default: one input and one output token. `null` reports no usage. */
	usage?: Record<string, number> | null;
}

const SCRIPT = `
import { appendFileSync, chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, join } from "path";
const dir = process.argv[2];
const args = process.argv.slice(3);
if (args.includes("--version")) { console.log("0.0.0 (fake)"); process.exit(0); }
const steps = JSON.parse(readFileSync(join(dir, "steps.json"), "utf8"));
const counter = join(dir, "count");
const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
writeFileSync(counter, String(n + 1));
const step = steps[Math.min(n, steps.length - 1)] ?? {};
let buffer = "";
let started = false;
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	const lines = buffer.split("\\n");
	buffer = lines.pop();
	for (const line of lines) {
		if (!line.trim()) continue;
		const message = JSON.parse(line);
		if (message.type !== "user" || started) continue;
		started = true;
		const files = step.listFiles ? listFiles(process.cwd(), "") : undefined;
		appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ cwd: process.cwd(), args, prompt: message.message.content, files }) + "\\n");
		act();
	}
});
process.stdin.on("end", () => process.exit(0));
function listFiles(root, sub) {
	const found = [];
	for (const entry of readdirSync(join(root, sub), { withFileTypes: true })) {
		const path = sub ? sub + "/" + entry.name : entry.name;
		if (entry.isDirectory()) found.push(...listFiles(root, path));
		else found.push(path);
	}
	return found.sort();
}
function act() {
	if (step.model) process.stdout.write(JSON.stringify({ type: "system", subtype: "init", model: step.model }) + "\\n");
	if (step.tamper) {
		const file = join(process.cwd(), step.tamper);
		chmodSync(dirname(file), 0o755);
		writeFileSync(file, "tampered\\n");
	}
	if (step.hang) return setInterval(() => {}, 1000);
	if (step.commit) {
		writeFileSync(join(process.cwd(), step.commit), "built\\n");
		execFileSync("git", ["add", "-A"]);
		execFileSync("git", ["commit", "--quiet", "-m", "Build " + step.commit]);
	}
	if (step.checkout) execFileSync("git", ["checkout", "--quiet", "-b", step.checkout]);
	const result = { type: "result", subtype: "success", is_error: false, result: "Finished." };
	if (step.usage !== null) result.usage = step.usage ?? { input_tokens: 1, output_tokens: 1 };
	if (step.answer) result.structured_output = step.answer;
	process.stdout.write(JSON.stringify(result) + "\\n");
}
`;

/** A fake Claude Code CLI, run with node. `steps` says what each run does; `calls` lists each run's folder, arguments and prompt. */
export function fakeClaude(steps: FakeStep[]) {
	const dir = tempFolder();
	write(dir, { "fake.mjs": SCRIPT, "steps.json": JSON.stringify(steps) });
	const command = join(dir, "claude");
	writeFileSync(command, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake.mjs")}" "${dir}" "$@"\n`);
	chmodSync(command, 0o755);
	return {
		command,
		/** Replaces the steps, and starts again from the first. */
		setSteps: (next: FakeStep[]) => {
			writeFileSync(join(dir, "steps.json"), JSON.stringify(next));
			rmSync(join(dir, "count"), { force: true });
		},
		calls: (): { cwd: string; args: string[]; prompt: string; files?: string[] }[] =>
			existsSync(join(dir, "calls.jsonl"))
				? readFileSync(join(dir, "calls.jsonl"), "utf8")
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line))
				: [],
	};
}

/** A code repository at `project/{name}` on `main`, with a bare `origin` beside the project folder, pushed and tracking. */
export async function repoWithOrigin(project: string, name: string, files: Record<string, string> = { "README.md": "readme\n" }) {
	const remotes = join(project, "..", "remotes");
	const bare = join(remotes, `${name}.git`);
	mkdirSync(remotes, { recursive: true });
	await git(remotes, ["init", "--quiet", "--bare", "-b", "main", bare]);
	const repo = join(project, name);
	await initRepo(repo, files);
	await git(repo, ["remote", "add", "origin", bare]);
	await git(repo, ["push", "--quiet", "-u", "origin", "main"]);
	await git(repo, ["remote", "set-head", "origin", "main"]);
	return { repo, bare };
}
