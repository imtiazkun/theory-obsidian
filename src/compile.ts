import { ChildProcess, spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync, statSync } from "fs";
import { mkdtemp, readFile, readdir, realpath, rm } from "fs/promises";
import { tmpdir } from "os";
import { basename, isAbsolute, join, relative, resolve, sep } from "path";
import { runAcpAgent } from "./acp";
import { Anchor, Problem, checkAnchors, checkProblems, plainProblem } from "./anchor";
import { CompileBranch, PreparedBranch, dirtyRepos, finishBranches, prepareBranches, undoBranches } from "./branches";
import type { PullRequest } from "./github";
import { findProjectRepos } from "./project";
import { toolPath } from "./tool-path";
import { git, isInDotFolder } from "./vault";

/** Tag in the vault repository that marks the last compiled commit. */
export const COMPILED_TAG = "theory/compiled";
// Git's well-known empty tree, used to diff the whole model on the first compile.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// Larger diffs are cut; Claude can still read every file in the snapshot.
const MAX_DIFF_CHARS = 200_000;
const MAX_LOG_LINES = 500;
/** Git pathspec for files in dot folders, like `.obsidian/` and `.comments/`, at any depth. They are never theory. */
export const DOT_FOLDERS = ":(exclude,glob)**/.*/**";
// Git pathspecs for vault files that are never sent to Claude: dot folders (INV-13), hidden folders and
// hidden notes (name starts with `_`, at any depth), and the human-only Instructions.md.
export const NOT_SENT = [
	DOT_FOLDERS,
	":(exclude,glob)**/_*/**",
	":(exclude,glob)**/_*",
	":(exclude).obsidian/",
	":(exclude,icase)instructions.md",
	":(exclude,icase)instruction.md",
];

export type PermissionMode = "acceptEdits" | "auto" | "bypassPermissions";
/** The agent that compiles: Claude Code (the default) or an agent speaking the Agent Client Protocol over stdio. */
export type CompileAgent = "claude" | "acp";
/** A Claude Code model alias, or "" to let Claude Code decide. Aliases always mean the latest model of their kind. */
export type CompileModel = "" | "fable" | "opus" | "sonnet" | "haiku";
/** A Claude Code effort level, or "" to let Claude Code decide. */
export type CompileEffort = "" | "low" | "medium" | "high" | "xhigh" | "max";

/** A request nobody answers in this time is denied, so a compile never hangs. */
export const PERMISSION_TIMEOUT_MS = 120_000;

/** The time left until `expiresAt`, as "m:ss". */
export function timeLeft(expiresAt: number): string {
	const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
// Tools that write files. Their writes to the vault or the snapshot are denied before any card is shown.
const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit", "MultiEdit"];

export type PermissionAnswer = "allow" | "always" | "deny";

/** A tool call the Allowed commands setting doesn't cover, waiting for the engineer to answer. */
export interface PermissionRequest {
	id: string;
	tool: string;
	/** The exact command or file. */
	target: string;
	/** Why Claude wants it, in Claude's words. */
	reason: string;
	/** The rules Always allow adds to Allowed commands, or none when there is nothing to add (a file tool with no file). */
	rules: string[];
	/** True for an ACP agent's request: Always allow lasts for this compile only and never changes Allowed commands. */
	sessionOnly?: boolean;
	/** When the request is denied by itself, in milliseconds since the epoch. */
	expiresAt: number;
	/** Where the request sits in the report's activity log. Its card shows there, and its answer replaces that line. */
	line: number;
}

export interface CompileOptions {
	vaultPath: string;
	/** Folder holding the project's code: one repository, or several side by side. Claude works here. */
	projectFolder: string;
	claudeCommand: string;
	/** Which agent compiles. Claude Code when unset. */
	agent?: CompileAgent;
	/** The command that starts the ACP agent, with its arguments. Used when `agent` is "acp". */
	agentCommand?: string;
	/** The ACP agent's model, by value or name. "" or unset means the agent's default. Never Claude Code's model (AGT-24). */
	agentModel?: string;
	/** The ACP agent's thinking level, by value or name. "" or unset means the agent's default. */
	agentThinkingLevel?: string;
	permissionMode: PermissionMode;
	/** Space-separated Claude Code permission rules, e.g. `Bash(npm run *)`. */
	allowedTools: string;
	model: CompileModel;
	effort: CompileEffort;
	/** Who runs the compile, shown in the compile history. */
	author: string;
	/** Earlier reports, newest first. They hold each compile branch's base and pull request. */
	reports: CompileReport[];
	/** Called when Claude asks for a tool call the settings don't allow. */
	onPermissionRequest?: (request: PermissionRequest) => void;
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
	/** The text in the model the question is about, checked like problem anchors. Reply opens the note there. */
	anchors?: Anchor[];
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
	/** Who ran the compile: the author name from settings, else from the git config. */
	author?: string;
	/** Every token Claude Code counted in this compile: input, output and cache. Unset when it never reported usage. */
	tokens?: number;
	/** "acp" when an ACP agent compiled. Unset for Claude Code. An ACP agent reports no token count. */
	agent?: CompileAgent;
	/** Each repository's compile branch, its base and the commits this compile added. Set once Claude has finished. */
	branches?: CompileBranch[];
	/** Pull requests opened from this report with Create PR. */
	pullRequests?: PullRequest[];
}

/**
 * How many committed revisions are waiting to be compiled. A revision that changes only files in dot
 * folders, like a comment, is never pending.
 */
export async function pendingRevisionCount(vaultPath: string): Promise<number> {
	const head = await headCommit(vaultPath).catch(() => null);
	if (!head) return 0;
	const from = await tagCommit(vaultPath);
	if (from === head) return 0;
	const { stdout } = await git(vaultPath, ["rev-list", "--count", from ? `${from}..${head}` : head, "--", DOT_FOLDERS]);
	return Number(stdout.trim()) || 0;
}

/** The rules Always allow saves to Allowed commands for this request. An ACP agent's request saves none (AGT-14). */
export function rulesToSave(request: PermissionRequest, answer: PermissionAnswer): string[] {
	if (answer !== "always" || request.sessionOnly) return [];
	return request.rules;
}

/** Thrown when every committed revision has already been compiled. */
export class NothingToCompileError extends Error {}

const ANCHOR_SCHEMA = {
	type: "object",
	properties: {
		path: { type: "string", description: "Model file path, relative to the model directory." },
		heading: { type: "string", description: "Heading the text sits under, as written." },
		quote: {
			type: "string",
			description: "Short text copied exactly from the note, Markdown included. One sentence at most.",
		},
	},
	required: ["path"],
};

export const REPORT_SCHEMA = {
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
					anchors: {
						type: "array",
						description:
							"Where in the model the rule that needs updating sits: the file, its heading and a short quote of the rule.",
						items: ANCHOR_SCHEMA,
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
						items: ANCHOR_SCHEMA,
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

export async function revisionsBetween(vaultPath: string, from: string | null, to: string): Promise<Revision[]> {
	const format = ["%H", "%an", "%aI", "%s"].join(FIELD);
	// Revisions that change only dot folders are never pending, so they aren't listed either.
	const { stdout } = await git(vaultPath, ["log", "--reverse", `--format=${format}`, from ? `${from}..${to}` : to, "--", DOT_FOLDERS]);
	return stdout
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => {
			const [hash, author, date, subject] = line.split(FIELD);
			return { hash, author, date, subject };
		});
}

export async function modelDiff(vaultPath: string, from: string | null, to: string): Promise<string> {
	const { stdout } = await git(vaultPath, ["diff", "--stat", "--patch", from ?? EMPTY_TREE, to, "--", ...NOT_SENT]);
	if (stdout.length <= MAX_DIFF_CHARS) return stdout;
	return stdout.slice(0, MAX_DIFF_CHARS) + "\n\n[Diff cut short. Read the changed files in the model directory.]\n";
}

/** Notes that changed between the two commits, to point at when a failed compile names no spot. */
async function changedNotes(vaultPath: string, from: string | null, to: string): Promise<string[]> {
	const { stdout } = await git(vaultPath, ["diff", "--name-only", "-z", "--diff-filter=d", from ?? EMPTY_TREE, to, "--", ...NOT_SENT]);
	return stdout.split("\0").filter((path) => path.toLowerCase().endsWith(".md"));
}

/**
 * Changed paths in the vault working tree, so edits made during a compile can be spotted. Dot folders
 * are left out, since an engineer may comment while a compile runs (INV-6).
 */
export async function workingTreeState(vaultPath: string): Promise<Map<string, string>> {
	const { stdout } = await git(vaultPath, ["status", "--porcelain", "-z", "--untracked-files=all"]);
	const state = new Map<string, string>();
	for (const entry of stdout.split("\0")) {
		if (entry === "") continue;
		const path = entry.slice(3);
		if (isInDotFolder(path)) continue;
		const full = join(vaultPath, path);
		// The modified time tells apart a file that was already dirty from one edited again.
		state.set(path, existsSync(full) ? String(statSync(full).mtimeMs) : "deleted");
	}
	return state;
}

/** Checks out `commit`, minus the files never sent to Claude, into a fresh read-only directory outside the vault. */
export async function createSnapshot(vaultPath: string, commit: string): Promise<string> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "theory-model-")));
	const archive = `${dir}.tar`;
	await git(vaultPath, ["archive", "--format=tar", "-o", archive, commit, "--", ...NOT_SENT]);
	await runTool("tar", ["-xf", archive, "-C", dir]);
	await rm(archive, { force: true });
	await runTool("chmod", ["-R", "a-w", dir]);
	return dir;
}

export async function removeSnapshot(dir: string) {
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
		const child = spawn(command, args, { env: { ...process.env, PATH: toolPath() } });
		let stderr = "";
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (code) =>
			code === 0 ? resolve() : reject(new Error(`${command} failed: ${stderr.trim() || `exit ${code}`}`)),
		);
	});
}

/** The `instructions.md` in a repository's model folder, matched ignoring case, or null when it has none. */
async function modelInstructions(snapshot: string, repo: string): Promise<{ path: string; text: string } | null> {
	const folder = join(snapshot, repo);
	const entries = await readdir(folder).catch(() => [] as string[]);
	const name = entries.find((entry) => entry.toLowerCase() === "instructions.md");
	if (!name) return null;
	const text = await readFile(join(folder, name), "utf8").catch(() => null);
	return text === null ? null : { path: `${repo}/${name}`, text };
}

function buildPrompt(params: {
	snapshot: string;
	projectFolder: string;
	head: string;
	from: string | null;
	revisions: Revision[];
	diff: string;
	branches: PreparedBranch[];
	instructions: { repo: string; path: string; text: string }[];
}): string {
	const { snapshot, projectFolder, head, from, revisions, diff, branches, instructions } = params;
	const found = findProjectRepos(projectFolder);
	const branchOf = (path: string) => {
		const branch = branches.find((b) => b.path === path)?.branch;
		return branch ? ` (checked out on branch ${branch})` : "";
	};
	const repoList =
		found.kind === "root"
			? `The project folder is a single git repository${branchOf(projectFolder)}.`
			: found.kind === "children"
				? `Git repositories in the project folder:\n${found.repos.map((repo) => `- ${relative(projectFolder, repo)}${branchOf(repo)}`).join("\n")}`
				: "The project folder has no git repositories yet.";
	const instructionList = instructions
		.map((i) => `### ${i.repo} (${i.path} in the model directory)\n\n${i.text.trim()}`)
		.join("\n\n");
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
- If the model is unclear, incomplete or contradicts itself, don't guess. Add a question to \`questions\`, naming the model files it is about with paths relative to the model directory. Give it \`anchors\` pointing at the rule that needs updating: the model file, the heading it sits under, and a short quote of the rule copied exactly from the note. Carry on with the parts that are clear.
- Only change files inside the project folder.
- Before changing a repository, read its AGENTS.md (and CLAUDE.md, if there is one) and follow its rules, including how to test.
- Notes at the root of the model directory describe the whole system. Notes in a folder named after a repository describe that repository only.
- Before changing a repository, also read \`instructions.md\` in that repository's folder in the model directory and follow it. When it disagrees with AGENTS.md, the model's \`instructions.md\` wins, because the model is the source of truth.
- When you commit in a code repository, end each commit message with the trailer \`Model-Revision: ${head}\`.
- When the project has several repositories, start each entry in \`changes\` and \`problems\` with the repository name in brackets, e.g. "[mobile] ...".
- Put anything that went wrong (steps you couldn't do) in \`problems\`.
- When a problem comes from something in the model, give it \`anchors\`: the model file, the heading it sits under, and a short quote copied exactly from the note (under 200 characters). Engineers see these as highlights in the note. Leave \`anchors\` empty when the problem isn't about the model.
- Set \`status\` to "failed" if the code doesn't match the model at the end.
- Commit on the branch that is checked out in each repository. Never create, switch, merge or push branches.
${instructionList ? `\n## Instructions for each repository\n\n${instructionList}\n` : ""}
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

/** The exact command, file or address a tool call is about, as shown on its permission card. */
function requestTarget(tool: string, input: Record<string, unknown>): string {
	const detail = input.command ?? input.file_path ?? input.notebook_path ?? input.url ?? input.pattern ?? input.path;
	if (typeof detail === "string" && detail) return detail;
	const json = JSON.stringify(input);
	return json === "{}" ? tool : json;
}

/** The file a write tool would change, made absolute against the project folder. */
function writtenFile(tool: string, input: Record<string, unknown>, projectFolder: string): string | null {
	if (!WRITE_TOOLS.includes(tool)) return null;
	const path = input.file_path ?? input.notebook_path;
	if (typeof path !== "string" || !path) return null;
	return isAbsolute(path) ? resolve(path) : resolve(projectFolder, path);
}

function isInside(path: string, dir: string): boolean {
	const root = resolve(dir);
	return path === root || path.startsWith(root + sep);
}

/** A Claude Code permission rule as written in Allowed commands, e.g. `Bash(npm run:*)`. */
function ruleText(rule: unknown): string | null {
	if (!rule || typeof rule !== "object") return null;
	const { toolName, ruleContent } = rule as Record<string, unknown>;
	if (typeof toolName !== "string" || !toolName) return null;
	return typeof ruleContent === "string" && ruleContent ? `${toolName}(${ruleContent})` : toolName;
}

/** Every allow rule Claude Code suggests for this tool with a permission request, in order, without repeats. */
function suggestedRules(tool: string, suggestions: unknown): string[] {
	const rules: string[] = [];
	if (!Array.isArray(suggestions)) return rules;
	for (const update of suggestions) {
		if (update?.type !== "addRules" || update.behavior !== "allow" || !Array.isArray(update.rules)) continue;
		for (const rule of update.rules) {
			const text = rule?.toolName === tool ? ruleText(rule) : null;
			if (text && !rules.includes(text)) rules.push(text);
		}
	}
	return rules;
}

/**
 * The rules Always allow adds to Allowed commands, all shown on the card before the engineer clicks.
 * A command gets every rule Claude Code suggests (a compound command may get one per part, and each
 * may cover a family of commands), else the exact command, so the same command never asks twice.
 * A file tool gets that tool on that exact file, never the bare tool name nor Claude Code's suggestion,
 * so one approval opens one file only. Any other tool gets Claude Code's suggestion, else its name.
 */
export function requestRules(tool: string, input: Record<string, unknown>, projectFolder: string, suggestions: unknown): string[] {
	if (WRITE_TOOLS.includes(tool)) {
		const file = writtenFile(tool, input, projectFolder);
		return file ? [`${tool}(//${file.replace(/^\//, "")})`] : [];
	}
	const suggested = suggestedRules(tool, suggestions);
	if (tool === "Bash") {
		if (suggested.length > 0) return suggested;
		if (typeof input.command === "string" && input.command) return [`Bash(${input.command})`];
		return [tool];
	}
	return [suggested[0] ?? tool];
}

/** Allowed commands with `rules` added at the end, none of them twice. This is what Always allow saves. */
export function withAllowedRules(allowedTools: string, rules: string[]): string {
	// Matched with the spaces around it, because a rule like `Bash(npm run build)` has spaces inside.
	let list = allowedTools.trim();
	for (const rule of rules) {
		if (!` ${list} `.includes(` ${rule} `)) list = list ? `${list} ${rule}` : rule;
	}
	return list;
}

/** Sums the token counts in a Claude Code `usage` object, or undefined when there are none. */
function totalTokens(usage: unknown): number | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const keys = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
	const counts = keys.map((key) => (usage as Record<string, unknown>)[key]).filter((n): n is number => typeof n === "number");
	return counts.length > 0 ? counts.reduce((sum, n) => sum + n, 0) : undefined;
}

/** The summary when Claude Code fails to sign in (CMP-54). */
export const SIGN_IN_SUMMARY = "Claude Code isn't signed in. Run claude in a terminal, then /login.";

/** True when Claude Code's answer or error output says it couldn't sign in (CMP-54). */
export function signInFailed(output: string): boolean {
	return /not logged in|please run \/login|invalid api key|oauth token (?:has )?expired|authentication_error|failed to authenticate/i.test(
		output,
	);
}

/** The agent's answer in the shape of REPORT_SCHEMA (CMP-15). */
export interface StructuredAnswer {
	status: "succeeded" | "failed";
	summary: string;
	changes: string[];
	/** Question anchors are checked by `checkAnchors` before anything is shown. */
	questions: (Omit<Question, "anchors"> & { anchors?: unknown })[];
	/** Checked by `checkProblems` before anything is shown. */
	problems: unknown;
}

export interface AgentResult {
	isError: boolean;
	text: string;
	structured?: StructuredAnswer;
}

/** How the agent's run ended. */
export interface AgentOutcome {
	result: AgentResult | null;
	code: number | null;
	/** Set when the agent couldn't be started. */
	error?: Error;
	/** Why an ACP agent stopped: its stop reason, or the error that ended its turn. */
	stopReason?: string;
	stderr: string;
}

/** What the compile offers the agent it runs: the activity log, permission cards and problems. */
export interface AgentHost {
	log(line: string): void;
	/**
	 * Shows a permission card. `respond` is called once with the engineer's answer, a timeout ("deny"),
	 * or "cancelled" when the compile ends first. `message` says why, for the agent.
	 */
	ask(
		request: Omit<PermissionRequest, "expiresAt" | "line">,
		respond: (choice: PermissionAnswer | "cancelled", message: string) => void,
	): void;
	/** Closes a card the agent withdrew before anyone answered. */
	withdraw(id: string): void;
	/** A step that didn't run. It becomes a problem. */
	skip(problem: string): void;
	/** Answers every open request, e.g. when the agent finished. */
	closeAll(message: string): void;
}

export interface AgentRun {
	done: Promise<AgentOutcome>;
	cancel(): void;
}

/** What an ACP agent is told on top of the prompt Claude Code gets: the answer's shape (AGT-9). */
export function acpAnswerInstructions(): string {
	return `
## Your answer

When you are done, end your last message with your answer as one JSON block in a \`\`\`json fence. It must match this JSON Schema:

\`\`\`json
${JSON.stringify(REPORT_SCHEMA, null, 2)}
\`\`\`
`;
}

export interface CompileRun {
	report: CompileReport;
	done: Promise<CompileReport>;
	/** Permission requests waiting for an answer, oldest first. */
	requests: PermissionRequest[];
	/** Answers one request. Each request is answered on its own, never in bulk. */
	answer(id: string, answer: PermissionAnswer): void;
	cancel(): void;
}

/**
 * Starts a compile of every vault revision committed since the last compile.
 * Throws before anything runs when the compile can't start; after that, every
 * outcome is recorded in the returned report.
 */
export async function startCompile(options: CompileOptions, onUpdate: (report: CompileReport) => void): Promise<CompileRun> {
	const { vaultPath, projectFolder } = options;
	const agent: CompileAgent = options.agent ?? "claude";
	if (!projectFolder) throw new Error("Choose the project folder in theory.md settings first.");
	if (!existsSync(projectFolder) || !statSync(projectFolder).isDirectory()) {
		throw new Error(`The project folder doesn't exist: ${projectFolder}`);
	}
	if (agent === "acp" && !options.agentCommand?.trim()) {
		throw new Error("Set the agent command in theory.md settings first.");
	}

	const head = await headCommit(vaultPath);
	const from = await tagCommit(vaultPath);
	if (from === head || (await pendingRevisionCount(vaultPath)) === 0) {
		throw new NothingToCompileError("Every committed revision is already compiled.");
	}
	// The engineer's unfinished work must never end up on a compile branch.
	const dirty = await dirtyRepos(projectFolder);
	if (dirty.length > 0) {
		throw new Error(`These repositories have uncommitted changes: ${dirty.join(", ")}. Commit or stash them first.`);
	}

	const revisions = await revisionsBetween(vaultPath, from, head);
	const diff = await modelDiff(vaultPath, from, head);
	const notes = await changedNotes(vaultPath, from, head);
	const snapshot = await createSnapshot(vaultPath, head);

	const snapshotHash = await hashTree(snapshot);
	const vaultBefore = await workingTreeState(vaultPath);

	const instructions: { repo: string; path: string; text: string }[] = [];
	const found = findProjectRepos(projectFolder);
	if (found.kind === "root" || found.kind === "children") {
		for (const repo of found.repos) {
			const name = relative(projectFolder, repo) || basename(repo);
			const file = await modelInstructions(snapshot, name);
			if (file) instructions.push({ repo: name, ...file });
		}
	}
	// The plugin, never Claude, puts every repository on a compile branch before Claude runs.
	let branches: PreparedBranch[];
	try {
		branches = await prepareBranches(projectFolder, head, options.reports);
	} catch (error) {
		await removeSnapshot(snapshot);
		throw error;
	}

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
		log: branches.map((b) => `Checked out ${b.branch} in ${b.name}${b.created ? ` (new, from ${b.base})` : ""}`),
		author: options.author,
		...(agent === "acp" ? { agent } : {}),
	};

	let cancelled = false;
	const requests: PermissionRequest[] = [];
	const log = (line: string) => {
		report.log.push(line);
		if (report.log.length > MAX_LOG_LINES) {
			report.log.shift();
			for (const request of requests) request.line--;
		}
		onUpdate(report);
	};

	type Respond = (choice: PermissionAnswer | "cancelled", message: string) => void;
	const pending = new Map<string, { respond: Respond; timer: ReturnType<typeof setTimeout> }>();
	// Steps that didn't run because a request was denied or timed out. Each becomes a problem.
	const skipped: string[] = [];

	/** Closes a request. Its card becomes one line in the activity log, e.g. "Allowed: npm test". */
	const close = (id: string, outcome: string) => {
		const open = pending.get(id);
		if (!open) return null;
		clearTimeout(open.timer);
		pending.delete(id);
		const index = requests.findIndex((r) => r.id === id);
		const [request] = index >= 0 ? requests.splice(index, 1) : [];
		if (request) {
			const text = `${outcome}: ${request.target}`;
			if (request.line >= 0 && request.line < report.log.length) report.log[request.line] = text;
			else report.log.push(text);
		}
		onUpdate(report);
		return request ? { request, respond: open.respond } : null;
	};

	const answer = (id: string, choice: PermissionAnswer) => {
		const closed = close(id, choice === "deny" ? "Denied" : choice === "always" ? "Always allowed" : "Allowed");
		if (!closed) return;
		const { request, respond } = closed;
		if (choice === "deny") {
			skipped.push(`You denied ${request.tool}: ${request.target}. ${agent === "acp" ? "The agent" : "Claude"} carried on without it.`);
			respond("deny", "The engineer denied this. Carry on without this step and name it in problems.");
			return;
		}
		respond(choice, "");
	};

	/** Denies every open request, e.g. on cancel or when the agent exits. */
	const denyAll = (message: string, choice: "deny" | "cancelled" = "deny") => {
		for (const id of [...pending.keys()]) {
			const closed = close(id, "Denied");
			if (!closed) continue;
			skipped.push(`${closed.request.tool}: ${closed.request.target} was denied because ${message}.`);
			closed.respond(choice, `Denied because ${message}.`);
		}
	};

	const host: AgentHost = {
		log,
		ask(request, respond) {
			const permission: PermissionRequest = {
				...request,
				expiresAt: Date.now() + PERMISSION_TIMEOUT_MS,
				line: report.log.length,
			};
			const timer = setTimeout(() => {
				if (!close(permission.id, "Timed out")) return;
				const step = `${permission.tool}: ${permission.target}`;
				skipped.push(
					`Nobody answered the request for ${step} within 120 seconds, so it was denied. ${agent === "acp" ? "The agent" : "Claude"} carried on without it.`,
				);
				respond("deny", "Nobody answered in time, so this was denied. Carry on without this step and name it in problems.");
			}, PERMISSION_TIMEOUT_MS);
			pending.set(permission.id, { respond, timer });
			requests.push(permission);
			// The card shows on this line until it's answered.
			log(`Asking: ${permission.target}`);
			options.onPermissionRequest?.(permission);
		},
		withdraw: (id) => void close(id, "Withdrawn"),
		skip: (problem) => void skipped.push(problem),
		closeAll: (message) => denyAll(message),
	};

	const protectedPaths = [vaultPath, snapshot];
	const prompt = buildPrompt({ snapshot, projectFolder, head, from, revisions, diff, branches, instructions });
	let agentRun: AgentRun;
	try {
		agentRun =
			agent === "acp"
				? runAcpAgent(
						{
							command: options.agentCommand ?? "",
							projectFolder,
							snapshot,
							protectedPaths,
							// Same prompt as Claude Code, plus the answer's shape, since ACP has none built in.
							prompt: prompt + acpAnswerInstructions(),
							model: options.agentModel ?? "",
							thinkingLevel: options.agentThinkingLevel ?? "",
						},
						host,
					)
				: runClaudeCode(options, { snapshot, protectedPaths, prompt, report }, host);
	} catch (error) {
		await undoBranches(branches);
		await removeSnapshot(snapshot);
		throw error;
	}
	const agentName = agent === "acp" ? "The agent" : "Claude Code";

	/**
	 * The snapshot check (INV-5) and the vault check (INV-6). They run after every compile in which an agent
	 * started, cancelled ones included, whatever the agent, because an agent's own shell can write anywhere
	 * the engineer can (AGT-17, INV-12). They never change a cancelled compile's status or move the marker.
	 */
	const checkModel = async () => {
		const intact = (await hashTree(snapshot).catch(() => "")) === snapshotHash;
		const vaultAfter = await workingTreeState(vaultPath).catch(() => vaultBefore);
		// A file that was dirty before and is clean now changed too, so compare both ways.
		const paths = new Set([...vaultBefore.keys(), ...vaultAfter.keys()]);
		const touched = [...paths].filter((path) => vaultBefore.get(path) !== vaultAfter.get(path));
		return { intact, touched };
	};
	const modelProblems = ({ intact, touched }: { intact: boolean; touched: string[] }): Problem[] => [
		...(touched.length > 0
			? [plainProblem(`These vault files changed while the compile ran: ${touched.join(", ")}. If you didn't edit them, revert them.`)]
			: []),
		...(intact ? [] : [plainProblem("Claude tried to change the model snapshot. Those changes were thrown away.")]),
	];

	const done = (async () => {
		const { result, code, error, stopReason, stderr } = await agentRun.done;
		denyAll(`${agentName} exited`);
		try {
			// Whatever the outcome, a new branch without commits goes, and its repository goes back to its base.
			report.branches = await finishBranches(branches);
			for (const b of report.branches) {
				if (!b.kept) log(`Deleted ${b.branch} in ${b.repo}, which got no commits, and checked out ${b.base}`);
			}
			// Uncommitted work would block the next compile, so the engineer must hear about it.
			const left = await dirtyRepos(projectFolder).catch(() => []);
			if (left.length > 0) skipped.push(`These repositories have uncommitted changes after the compile: ${left.join(", ")}.`);
			if (cancelled) {
				report.status = "cancelled";
				report.summary = "You cancelled this compile. The last compile marker didn't move.";
				report.problems.unshift(...modelProblems(await checkModel()));
				return report;
			}
			if (error) {
				report.status = "failed";
				report.summary = `${agent === "acp" ? "The agent" : "Claude Code"} couldn't be started.`;
				const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
				report.problems.push(
					plainProblem(
						!missing
							? error.message
							: agent === "acp"
								? `Couldn't find the agent ("${options.agentCommand}"). Set its command in theory.md settings.`
								: `Couldn't find the Claude Code CLI ("${options.claudeCommand}"). Set its path in theory.md settings.`,
					),
				);
				report.problems.unshift(...modelProblems(await checkModel()));
				return report;
			}

			// Claude Code that can't sign in never read the revisions, so the compile couldn't start (CMP-54).
			if (agent !== "acp" && !result?.structured && signInFailed(`${result?.text ?? ""}\n${stderr}`)) {
				report.status = "failed";
				report.summary = SIGN_IN_SUMMARY;
				report.problems.unshift(...modelProblems(await checkModel()));
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
				report.summary = result?.text || `${agentName} finished without a report.`;
				report.problems.push(
					plainProblem(
						agent === "acp"
							? // The plugin stops an ACP agent itself, so its exit code means nothing (AGT-22).
								`The agent gave no structured answer. It stopped because: ${(stopReason ?? "unknown").replace(/\.$/, "")}. ${stderr.trim()}`.trim()
							: `Claude Code exited with code ${code}. ${stderr.trim()}`.trim(),
					),
				);
			}

			// The model must come back exactly as it went in.
			const checked = await checkModel();
			const { intact } = checked;
			// Anchors are only checked against a snapshot that is still the compiled revision.
			report.problems.push(...(await checkProblems(intact ? snapshot : null, claimedProblems)));
			// The engineer must know which steps didn't run, whatever Claude reported.
			report.problems.push(...skipped.map(plainProblem));
			for (let i = 0; i < report.questions.length; i++) {
				const anchors = await checkAnchors(intact ? snapshot : null, structured?.questions?.[i]?.anchors);
				if (anchors.length > 0) report.questions[i].anchors = anchors;
			}
			if (!intact) report.status = "failed";
			report.problems.unshift(...modelProblems(checked));

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
		requests,
		answer,
		cancel() {
			if (report.status !== "running" || cancelled) return;
			cancelled = true;
			// An ACP agent hears its open requests were cancelled (AGT-18); Claude Code hears they were denied.
			denyAll("the compile was cancelled", agent === "acp" ? "cancelled" : "deny");
			agentRun.cancel();
		},
	};
}

/** Runs Claude Code with `-p` and stream-json in the project folder for one compile. */
function runClaudeCode(
	options: CompileOptions,
	params: { snapshot: string; protectedPaths: string[]; prompt: string; report: CompileReport },
	host: AgentHost,
): AgentRun {
	const { projectFolder } = options;
	const { snapshot, protectedPaths, prompt, report } = params;
	const disallowed = protectedPaths.flatMap((path) =>
		["Edit", "Write", "NotebookEdit"].map((tool) => `${tool}(//${path.replace(/^\//, "")}/**)`),
	);
	const args = [
		"-p",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		// Tool calls the settings don't allow come back to us as `can_use_tool` requests on stdout.
		"--permission-prompt-tool",
		"stdio",
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
	// Fixed when Claude Code starts, so a running compile keeps the model and effort it started with.
	if (options.model) args.push("--model", options.model);
	if (options.effort) args.push("--effort", options.effort);
	const allowed = options.allowedTools.trim();
	if (allowed) args.push("--allowedTools", allowed);

	const child: ChildProcess = spawn(options.claudeCommand || "claude", args, {
		cwd: projectFolder,
		env: { ...process.env, PATH: toolPath() },
	});

	const send = (message: unknown) => {
		if (child.stdin?.writable) child.stdin.write(JSON.stringify(message) + "\n");
	};
	// The process may exit while an answer is on its way.
	child.stdin?.on("error", () => {});

	const reply = (id: string, response: Record<string, unknown>) =>
		send({ type: "control_response", response: { subtype: "success", request_id: id, response } });
	const deny = (id: string, message: string) => reply(id, { behavior: "deny", message });

	const handleControlRequest = (id: string, request: any) => {
		if (request?.subtype !== "can_use_tool") {
			send({ type: "control_response", response: { subtype: "error", request_id: id, error: "Not supported." } });
			return;
		}
		const tool = String(request.tool_name ?? "");
		const input: Record<string, unknown> = request.input ?? {};
		const file = writtenFile(tool, input, projectFolder);
		// Writes to the model never reach a card.
		if (file && protectedPaths.some((dir) => isInside(file, dir))) {
			host.skip(`Claude tried to write to the model (${file}). That was denied.`);
			host.log(`Denied: ${file}`);
			deny(id, "Writing to the model is forbidden. Carry on without this step.");
			return;
		}
		const description = typeof input.description === "string" ? input.description : "";
		const reason = description || (typeof request.decision_reason === "string" ? request.decision_reason : "");
		const rules = requestRules(tool, input, projectFolder, request.permission_suggestions);
		host.ask(
			{
				id,
				tool,
				target: requestTarget(tool, input),
				reason: reason || "Claude didn't give a reason.",
				rules,
			},
			(choice, message) => {
				if (choice === "deny" || choice === "cancelled") return deny(id, message);
				const updated = rules.map((rule) => {
					const [toolName, ruleContent] = rule.match(/^([^(]+)(?:\((.*)\))?$/s)?.slice(1) ?? [tool];
					return ruleContent ? { toolName, ruleContent } : { toolName };
				});
				reply(id, {
					behavior: "allow",
					updatedInput: input,
					...(choice === "always" && updated.length > 0
						? { updatedPermissions: [{ type: "addRules", rules: updated, behavior: "allow", destination: "session" }] }
						: {}),
				});
			},
		);
	};

	const done = new Promise<AgentOutcome>((resolve) => {
		let result: AgentResult | null = null;
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
						host.log(describeToolUse(block.name, block.input ?? {}));
					}
				}
			} else if (event.type === "control_request") {
				handleControlRequest(String(event.request_id), event.request);
			} else if (event.type === "control_cancel_request") {
				host.withdraw(String(event.request_id));
			} else if (event.type === "result") {
				report.tokens = totalTokens(event.usage);
				result = {
					isError: Boolean(event.is_error) || event.subtype !== "success",
					text: typeof event.result === "string" ? event.result : "",
					structured: event.structured_output,
				};
				// Claude is done; closing stdin lets Claude Code exit.
				host.closeAll("Claude finished");
				child.stdin?.end();
			}
		};
		child.stdout?.on("data", (chunk) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			lines.forEach(handleLine);
		});
		child.stderr?.on("data", (chunk) => (stderr += chunk));
		child.on("error", (error) => {
			host.closeAll("Claude Code couldn't run");
			resolve({ result, code: null, error, stderr });
		});
		child.on("close", (code) => {
			handleLine(buffer);
			host.closeAll("Claude Code exited");
			resolve({ result, code, stderr });
		});
		// Stdin stays open for the answers to permission requests until the result arrives.
		send({ type: "control_request", request_id: "initialize", request: { subtype: "initialize", hooks: null } });
		// Keeps the prompt out of the argument list, which has a size limit.
		send({
			type: "user",
			message: { role: "user", content: prompt },
			parent_tool_use_id: null,
			session_id: "",
		});
	});

	return { done, cancel: () => child.kill("SIGTERM") };
}
