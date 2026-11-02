import { ChildProcess, spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync, statSync } from "fs";
import { mkdtemp, readFile, readdir, realpath, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, relative } from "path";
import { Problem, checkProblems, plainProblem } from "./anchor";
import { findProjectRepos } from "./project";
import { TOOL_PATH, git } from "./vault";

/** Tag in the vault repository that marks the last compiled commit. */
export const COMPILED_TAG = "theory/compiled";
// Git's well-known empty tree, used to diff the whole model on the first compile.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// Larger diffs are cut; Claude can still read every file in the snapshot.
const MAX_DIFF_CHARS = 200_000;
const MAX_LOG_LINES = 500;

export type PermissionMode = "acceptEdits" | "auto" | "bypassPermissions";

export interface CompileOptions {
	vaultPath: string;
	/** Folder holding the project's code: one repository, or several side by side. Claude works here. */
	projectFolder: string;
	claudeCommand: string;
	permissionMode: PermissionMode;
	/** Space-separated Claude Code permission rules, e.g. `Bash(npm run *)`. */
	allowedTools: string;
}

export interface Revision {
	hash: string;
	author: string;
	date: string;
	subject: string;
}

export interface Question {
	question: string;
	/** Model files the question is about, relative to the vault. */
	notes: string[];
}

export type CompileStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface CompileReport {
	id: string;
	status: CompileStatus;
	startedAt: string;
	finishedAt?: string;
	/** Last compiled commit before this run, or null on the first compile. */
	fromCommit: string | null;
	toCommit: string;
	revisions: Revision[];
	summary: string;
	changes: string[];
	questions: Question[];
	problems: Problem[];
	/** Model notes changed in the compiled revisions. Set only once Claude has run. */
	suspectNotes?: string[];
	/** True when the engineer cleared this failed compile's highlights from the notes. */
	dismissed?: boolean;
	/** Tools Claude used, as they happened. */
	log: string[];
}

/** How many committed revisions are waiting to be compiled. */
export async function pendingRevisionCount(vaultPath: string): Promise<number> {
	const head = await headCommit(vaultPath).catch(() => null);
	if (!head) return 0;
	const from = await tagCommit(vaultPath);
	if (from === head) return 0;
	const { stdout } = await git(vaultPath, ["rev-list", "--count", from ? `${from}..${head}` : head]);
	return Number(stdout.trim()) || 0;
}

/** Thrown when every committed revision has already been compiled. */
export class NothingToCompileError extends Error {}

const REPORT_SCHEMA = {
	type: "object",
	properties: {
		status: { type: "string", enum: ["succeeded", "failed"] },
		summary: { type: "string", description: "What this compile did, in two or three sentences." },
		changes: { type: "array", items: { type: "string" }, description: "Each change made to the code." },
		questions: {
			type: "array",
			items: {
				type: "object",
				properties: {
					question: { type: "string" },
					notes: {
						type: "array",
						items: { type: "string" },
						description: "Model file paths the question is about, relative to the model directory.",
					},
				},
				required: ["question", "notes"],
			},
		},
		problems: {
			type: "array",
			items: {
				type: "object",
				properties: {
					problem: { type: "string" },
					anchors: {
						type: "array",
						description: "Where in the model the problem comes from. Empty when it isn't about the model.",
						items: {
							type: "object",
							properties: {
								path: { type: "string", description: "Model file path, relative to the model directory." },
								heading: { type: "string", description: "Heading the problem sits under, as written." },
								quote: {
									type: "string",
									description: "Short text copied exactly from the note, Markdown included. One sentence at most.",
								},
							},
							required: ["path"],
						},
					},
				},
				required: ["problem", "anchors"],
			},
		},
	},
	required: ["status", "summary", "changes", "questions", "problems"],
};

async function tagCommit(vaultPath: string): Promise<string | null> {
	try {
		const { stdout } = await git(vaultPath, ["rev-parse", "--verify", "--quiet", `refs/tags/${COMPILED_TAG}^{commit}`]);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

async function headCommit(vaultPath: string): Promise<string> {
	try {
		const { stdout } = await git(vaultPath, ["rev-parse", "--verify", "HEAD"]);
		return stdout.trim();
	} catch {
		throw new Error("The vault has no commits yet. Commit your notes first.");
	}
}

const FIELD = "\x1f";

async function revisionsBetween(vaultPath: string, from: string | null, to: string): Promise<Revision[]> {
	const format = ["%H", "%an", "%aI", "%s"].join(FIELD);
	const { stdout } = await git(vaultPath, ["log", "--reverse", `--format=${format}`, from ? `${from}..${to}` : to]);
	return stdout
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => {
			const [hash, author, date, subject] = line.split(FIELD);
			return { hash, author, date, subject };
		});
}

async function modelDiff(vaultPath: string, from: string | null, to: string): Promise<string> {
	const { stdout } = await git(vaultPath, ["diff", "--stat", "--patch", from ?? EMPTY_TREE, to]);
	if (stdout.length <= MAX_DIFF_CHARS) return stdout;
	return stdout.slice(0, MAX_DIFF_CHARS) + "\n\n[Diff cut short. Read the changed files in the model directory.]\n";
}

/** Notes that changed between the two commits, to point at when a failed compile names no spot. */
async function changedNotes(vaultPath: string, from: string | null, to: string): Promise<string[]> {
	const { stdout } = await git(vaultPath, ["diff", "--name-only", "-z", "--diff-filter=d", from ?? EMPTY_TREE, to]);
	return stdout.split("\0").filter((path) => path.toLowerCase().endsWith(".md"));
}

/** Changed paths in the vault working tree, so edits made during a compile can be spotted. */
async function workingTreeState(vaultPath: string): Promise<Map<string, string>> {
	const { stdout } = await git(vaultPath, ["status", "--porcelain", "-z", "--untracked-files=all"]);
	const state = new Map<string, string>();
	for (const entry of stdout.split("\0")) {
		if (entry === "") continue;
		const path = entry.slice(3);
		const full = join(vaultPath, path);
		// The modified time tells apart a file that was already dirty from one edited again.
		state.set(path, existsSync(full) ? String(statSync(full).mtimeMs) : "deleted");
	}
	return state;
}

/** Checks out `commit` into a fresh read-only directory outside the vault. */
async function createSnapshot(vaultPath: string, commit: string): Promise<string> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "theory-model-")));
	const archive = `${dir}.tar`;
	await git(vaultPath, ["archive", "--format=tar", "-o", archive, commit]);
	await runTool("tar", ["-xf", archive, "-C", dir]);
	await rm(archive, { force: true });
	await runTool("chmod", ["-R", "a-w", dir]);
	return dir;
}

async function removeSnapshot(dir: string) {
	await runTool("chmod", ["-R", "u+w", dir]).catch(() => {});
	await rm(dir, { recursive: true, force: true });
}

/** A hash of every path and file in `dir`, to check nothing in the snapshot changed. */
async function hashTree(dir: string): Promise<string> {
	const hash = createHash("sha256");
	const walk = async (sub: string) => {
		const entries = await readdir(join(dir, sub), { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const path = join(sub, entry.name);
			hash.update(path + "\0");
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) hash.update(await readFile(join(dir, path)));
		}
	};
	await walk("");
	return hash.digest("hex");
}

function runTool(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { env: { ...process.env, PATH: TOOL_PATH } });
		let stderr = "";
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (code) =>
			code === 0 ? resolve() : reject(new Error(`${command} failed: ${stderr.trim() || `exit ${code}`}`)),
		);
	});
}

function buildPrompt(params: {
	snapshot: string;
	projectFolder: string;
	head: string;
	from: string | null;
	revisions: Revision[];
	diff: string;
}): string {
	const { snapshot, projectFolder, head, from, revisions, diff } = params;
	const found = findProjectRepos(projectFolder);
	const repoList =
		found.kind === "root"
			? "The project folder is a single git repository."
			: found.kind === "children"
				? `Git repositories in the project folder:\n${found.repos.map((repo) => `- ${relative(projectFolder, repo)}`).join("\n")}`
				: "The project folder has no git repositories yet.";
	const revisionList = revisions
		.map((r) => `- ${r.hash.slice(0, 7)} ${r.date} ${r.author}: ${r.subject}`)
		.join("\n");
	return `You are compiling a theoretical model into software.

The theoretical model is a set of notes, written only by humans, that describes a software ecosystem: what it does and why. Your job is to change the code in the project folder (the current directory) so that it matches the model. A model change may touch one repository, several, or none.

The model at revision ${head} is in this directory: ${snapshot}

${repoList}

Rules:
- The model is read-only. Never create, edit, move or delete anything in the model directory, and never write to the Obsidian vault it came from. Writing to the model is forbidden.
- The model is the source of truth. If the code disagrees with the model, change the code.
- A note whose front matter has \`realized: false\` is written ahead of the code. Don't build what it describes yet, and don't count it as a mismatch.
- If the model is unclear, incomplete or contradicts itself, don't guess. Add a question to \`questions\`, naming the model files it is about with paths relative to the model directory. Carry on with the parts that are clear.
- Only change files inside the project folder.
- Before changing a repository, read its AGENTS.md (and CLAUDE.md, if there is one) and follow its rules, including how to test.
- When you commit in a code repository, end each commit message with the trailer \`Model-Revision: ${head}\`.
- When the project has several repositories, start each entry in \`changes\` and \`problems\` with the repository name in brackets, e.g. "[mobile] ...".
- Put anything that went wrong (steps you couldn't do) in \`problems\`.
- When a problem comes from something in the model, give it \`anchors\`: the model file, the heading it sits under, and a short quote copied exactly from the note (under 200 characters). Engineers see these as highlights in the note. Leave \`anchors\` empty when the problem isn't about the model.
- Set \`status\` to "failed" if the code doesn't match the model at the end.

## Revisions since the last compile

${from ? `Last compiled revision: ${from}` : "This is the first compile, so the whole model is new."}

${revisionList}

## Changes to the model

\`\`\`diff
${diff}
\`\`\`
`;
}

/** Turns a tool call from Claude's stream into a short log line. */
function describeToolUse(name: string, input: Record<string, unknown>): string {
	const detail = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.description ?? "";
	const text = String(detail).split("\n")[0];
	return text ? `${name}: ${text.length > 160 ? text.slice(0, 157) + "…" : text}` : name;
}

interface ClaudeResult {
	isError: boolean;
	text: string;
	structured?: {
		status: "succeeded" | "failed";
		summary: string;
		changes: string[];
		questions: Question[];
		/** Checked by `checkProblems` before anything is shown. */
		problems: unknown;
	};
}

export interface CompileRun {
	report: CompileReport;
	done: Promise<CompileReport>;
	cancel(): void;
}

/**
 * Starts a compile of every vault revision committed since the last compile.
 * Throws before anything runs when the compile can't start; after that, every
 * outcome is recorded in the returned report.
 */
export async function startCompile(options: CompileOptions, onUpdate: (report: CompileReport) => void): Promise<CompileRun> {
	const { vaultPath, projectFolder } = options;
	if (!projectFolder) throw new Error("Choose the project folder in theory.md settings first.");
	if (!existsSync(projectFolder) || !statSync(projectFolder).isDirectory()) {
		throw new Error(`The project folder doesn't exist: ${projectFolder}`);
	}

	const head = await headCommit(vaultPath);
	const from = await tagCommit(vaultPath);
	if (from === head) throw new NothingToCompileError("Every committed revision is already compiled.");

	const revisions = await revisionsBetween(vaultPath, from, head);
	const diff = await modelDiff(vaultPath, from, head);
	const notes = await changedNotes(vaultPath, from, head);
	const snapshot = await createSnapshot(vaultPath, head);

	const snapshotHash = await hashTree(snapshot);
	const vaultBefore = await workingTreeState(vaultPath);

	const report: CompileReport = {
		id: `${Date.now()}`,
		status: "running",
		startedAt: new Date().toISOString(),
		fromCommit: from,
		toCommit: head,
		revisions,
		summary: "",
		changes: [],
		questions: [],
		problems: [],
		log: [],
	};

	const protectedPaths = [vaultPath, snapshot];
	const disallowed = protectedPaths.flatMap((path) =>
		["Edit", "Write", "NotebookEdit"].map((tool) => `${tool}(//${path.replace(/^\//, "")}/**)`),
	);
	const args = [
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--no-session-persistence",
		"--permission-mode",
		options.permissionMode,
		"--add-dir",
		snapshot,
		"--json-schema",
		JSON.stringify(REPORT_SCHEMA),
		"--disallowedTools",
		...disallowed,
	];
	const allowed = options.allowedTools.trim();
	if (allowed) args.push("--allowedTools", allowed);

	let child: ChildProcess;
	try {
		child = spawn(options.claudeCommand || "claude", args, {
			cwd: projectFolder,
			env: { ...process.env, PATH: TOOL_PATH },
		});
	} catch (error) {
		await removeSnapshot(snapshot);
		throw error;
	}

	let cancelled = false;
	const log = (line: string) => {
		report.log.push(line);
		if (report.log.length > MAX_LOG_LINES) report.log.shift();
		onUpdate(report);
	};

	const claudeDone = new Promise<{ result: ClaudeResult | null; code: number | null; error?: Error; stderr: string }>(
		(resolve) => {
			let result: ClaudeResult | null = null;
			let buffer = "";
			let stderr = "";
			const handleLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event.type === "assistant") {
					for (const block of event.message?.content ?? []) {
						if (block.type === "tool_use" && block.name !== "StructuredOutput") {
							log(describeToolUse(block.name, block.input ?? {}));
						}
					}
				} else if (event.type === "result") {
					result = {
						isError: Boolean(event.is_error) || event.subtype !== "success",
						text: typeof event.result === "string" ? event.result : "",
						structured: event.structured_output,
					};
				}
			};
			child.stdout?.on("data", (chunk) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				lines.forEach(handleLine);
			});
			child.stderr?.on("data", (chunk) => (stderr += chunk));
			child.on("error", (error) => resolve({ result, code: null, error, stderr }));
			child.on("close", (code) => {
				handleLine(buffer);
				resolve({ result, code, stderr });
			});
			// Keeps the prompt out of the argument list, which has a size limit.
			child.stdin?.end(buildPrompt({ snapshot, projectFolder, head, from, revisions, diff }));
		},
	);

	const done = (async () => {
		const { result, code, error, stderr } = await claudeDone;
		try {
			if (cancelled) {
				report.status = "cancelled";
				report.summary = "You cancelled this compile. The last compile marker didn't move.";
				return report;
			}
			if (error) {
				report.status = "failed";
				report.summary = "Claude Code couldn't be started.";
				report.problems.push(
					plainProblem(
						(error as NodeJS.ErrnoException).code === "ENOENT"
							? `Couldn't find the Claude Code CLI ("${options.claudeCommand}"). Set its path in theory.md settings.`
							: error.message,
					),
				);
				return report;
			}

			report.suspectNotes = notes;
			const structured = result?.structured;
			let claimedProblems: unknown = [];
			if (structured) {
				report.status = structured.status === "succeeded" && !result?.isError ? "succeeded" : "failed";
				report.summary = structured.summary;
				report.changes = structured.changes ?? [];
				report.questions = (structured.questions ?? []).map((q) => ({
					question: q.question,
					notes: (q.notes ?? []).map((note) => note.replace(/^\.?\//, "")),
				}));
				claimedProblems = structured.problems;
			} else {
				report.status = "failed";
				report.summary = result?.text || "Claude Code finished without a report.";
				if (code !== 0) {
					report.problems.push(plainProblem(`Claude Code exited with code ${code}. ${stderr.trim()}`.trim()));
				}
			}

			// The model must come back exactly as it went in.
			const intact = (await hashTree(snapshot).catch(() => "")) === snapshotHash;
			// Anchors are only checked against a snapshot that is still the compiled revision.
			report.problems.push(...(await checkProblems(intact ? snapshot : null, claimedProblems)));
			if (!intact) {
				report.status = "failed";
				report.problems.unshift(plainProblem("Claude tried to change the model snapshot. Those changes were thrown away."));
			}
			const vaultAfter = await workingTreeState(vaultPath);
			const touched = [...vaultAfter].filter(([path, mark]) => vaultBefore.get(path) !== mark).map(([path]) => path);
			if (touched.length > 0) {
				report.problems.unshift(
					plainProblem(
						`These vault files changed while the compile ran: ${touched.join(", ")}. If you didn't edit them, revert them.`,
					),
				);
			}

			// The marker moves even when the compile fails, so the next compile only takes newer revisions.
			await git(vaultPath, ["tag", "-f", COMPILED_TAG, head]);
			return report;
		} finally {
			report.finishedAt = new Date().toISOString();
			await removeSnapshot(snapshot);
			onUpdate(report);
		}
	})();

	return {
		report,
		done,
		cancel() {
			if (report.status !== "running" || cancelled) return;
			cancelled = true;
			child.kill("SIGTERM");
		},
	};
}
