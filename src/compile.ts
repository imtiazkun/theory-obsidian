import { ChildProcess, spawn } from "child_process";
import { existsSync, statSync } from "fs";
import { mkdtemp, readFile, readdir, realpath, rm } from "fs/promises";
import { tmpdir } from "os";
import { basename, isAbsolute, join, relative, resolve, sep } from "path";
import { runAcpAgent } from "./acp";
import { type TokenUsage, addUsage, claudeUsageParts } from "./costs";
import { CodeRead, CodeSnapshot, codeReadText, createCodeSnapshot, hashTree, removeSnapshot, runTool, trackedFiles } from "./code-snapshot";
import { Anchor, Problem, checkAnchors, checkProblems, plainProblem } from "./anchor";
import { dirtyRepos, projectRepos } from "./branches";
import type { BuildRecord } from "./build";
import { type GitHub, type PullRequest, ghGitHub } from "./github";
import { ClosingIssue, IssueRecord, PLAN_SCHEMA, SYNC_FAILURE, SyncError, canDiscard, closingIssues, discardIssues, fillIssueBodies, isEmptyPlan, issueRecords, readPlan, stepsLeft, syncIssues } from "./plan";
import { findProjectRepos } from "./project";
import { recompileProblem } from "./recompile";
import { fixedContextText, fixedParts } from "./fixed-context";
import { limitedDiff, readModelDiff } from "./model-diff";
import { changedRules, compileScope, ruleMap, ruleMapText, scopeText, searchRules } from "./rule-map";
import { toolPath } from "./tool-path";
import { type SharedBuild, type SharedPlace, markerCommit } from "./shared-report";
import { git, isInDotFolder } from "./vault";

export { removeSnapshot };

// Git's well-known empty tree, used to diff the whole model on the first compile.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// Larger diffs are shown with three lines of context, then cut; Claude can still read every file in the snapshot (CMP-11).
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

/** The agent settings a compile and a build run with (CMP-13, BLD-19). */
export interface AgentSettings {
	claudeCommand: string;
	/** Which agent runs. Claude Code when unset. */
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
}

export interface CompileOptions extends AgentSettings {
	vaultPath: string;
	/**
	 * Folder holding the project's code: one repository, or several side by side. Claude never reads it here: it
	 * reads each repository's default branch in the code snapshot (CMP-84).
	 */
	projectFolder: string;
	/**
	 * Paths of the repositories the pull before this compile fetched. The code of the others is read as of their last
	 * fetch (CMP-87). Unset means every repository was just fetched.
	 */
	fetched?: string[];
	/** Who runs the compile, shown in the compile history. */
	author: string;
	/** The email git signs with (CFG-34), for the shared report (REP-45). */
	authorEmail?: string;
	/** The GitHub Project every issue is added to, as its URL (CFG-40). */
	githubProject: string;
	/** How the plugin reaches GitHub. `gh` when unset; tests pass a fake (TEST-6). */
	github?: GitHub;
	/** Called when the agent asks for a tool call. A compile denies every one without a card (CMP-13), so this never fires for it. */
	onPermissionRequest?: (request: PermissionRequest) => void;
	/**
	 * The earlier compile to recompile (CMP-76): the revisions and the diff start where it started, and Claude also
	 * gets its issues that are still open, which the plan may continue (CMP-77, CMP-78).
	 */
	recompile?: CompileReport;
	/** Every saved report, to check again at start that `recompile` can still be recompiled (CMP-73, CMP-75). */
	reports?: CompileReport[];
	/**
	 * Commits the shared report (REP-46): when creating an issue fails and the report waits for Retry or Discard, and
	 * once the compile ends. Gets the snapshot folders, so the Activity log can name paths relative to them (REP-53).
	 * Never throws. Unset means nothing is shared.
	 */
	share?: (report: CompileReport, snapshots: { model: string; code: string }) => Promise<void>;
	/**
	 * The Share compile reports setting (CFG-44). Off: the marker is the local tag `theory/compiled`, and `share`
	 * moves it instead of writing to `.compiles/`. Unset means on.
	 */
	shareReports?: boolean;
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

/** `imported` is only the marker-only shared report that carried the old tag over (CFG-45). No compile ends so. */
export type CompileStatus = "running" | "succeeded" | "failed" | "cancelled" | "imported";

export interface CompileReport {
	id: string;
	status: CompileStatus;
	startedAt: string;
	finishedAt?: string;
	/**
	 * Last compiled commit before this run, or null on the first compile. A recompile starts where the compile it
	 * recompiles started (CMP-76), so this is that compile's start.
	 */
	fromCommit: string | null;
	/** For a recompile: the id of the compile it recompiles (CMP-76). */
	recompileOf?: string;
	/**
	 * For a recompile: the earlier compile's date and revision range, kept here so the report and the hooks can
	 * name it even once its own report is gone (REP-42, HOOK-3).
	 */
	earlier?: { startedAt: string; fromCommit: string | null; toCommit: string };
	toCommit: string;
	revisions: Revision[];
	summary: string;
	/** The code each repository was read at: its default branch and commit in the code snapshot (CMP-84, REP-43). */
	code?: CodeRead[];
	/** Changes a build made to the code, from Claude's answer for each issue. A compile makes none. */
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
	/**
	 * The compile's tokens in four parts, with the model that ran (REP-56). A build's go to its own record. Unset when the
	 * agent reported none. A number is the single count reports kept before REP-56: `costOf` reads both.
	 */
	tokens?: TokenUsage | number;
	/** "acp" when an ACP agent compiled. Unset for Claude Code. An ACP agent reports no token count. */
	agent?: CompileAgent;
	/** The issues this compile planned, the epic first, as far as they were created (REP-40). */
	issues?: IssueRecord[];
	/** Set while creating an issue failed and the report waits for Retry or Discard (CMP-68, CMP-81). */
	issueFailure?: string;
	/** In a recompile: the earlier compile's open issues its plan doesn't continue, closed in step 4 (CMP-80). */
	closing?: ClosingIssue[];
	/** The build of this compile's issues, once one started (BLD-3). */
	build?: BuildRecord;
	/** Pull requests for this compile's work: those a build opened, and those opened with Create PR. */
	pullRequests?: PullRequest[];
	/** The email git signed with for the engineer who compiled (CFG-34), for the shared report (REP-45). */
	authorEmail?: string;
	/** The model and effort (or an ACP agent's thinking level) the agent ran with. Unset or "" means its default. */
	model?: string;
	effort?: string;
	/**
	 * Whether this compile moved the last compile marker, once Claude ran (CMP-22). Unset when Claude never ran. The
	 * marker moves only when the shared report is committed with it (REP-49).
	 */
	markerMoved?: boolean;
	/** The report's file in `.compiles/` and its short id, once it was first shared (REP-44). */
	shared?: SharedPlace;
	/** Why the last commit or push of the shared report failed: it is then only in the data file (REP-48). */
	notShared?: string;
	/** Every build that ended, as the shared report keeps it (REP-45). */
	builds?: SharedBuild[];
	/**
	 * True for a report read from `.compiles/`, which another engineer's compile shared: its Activity comes from the
	 * shared log (REP-54), and its issue bodies from GitHub when a build or recompile needs them (REP-50).
	 */
	fromShared?: boolean;
	/**
	 * The files the shared report links, as last read from `.compiles/` (REP-41, REP-42). Kept so that writing the
	 * report never drops a link to a report this machine doesn't list.
	 */
	sharedLinks?: { recompileOf: string | null; recompiledBy: string | null };
	/**
	 * Set when this compile's shared report couldn't be pushed because the remote moved, and the remote's newest
	 * report had moved the marker past this compile's `from` (CMP-91): that report's file.
	 */
	compiledMeanwhile?: string;
}

/**
 * How many committed revisions are waiting to be compiled. A revision that changes only files in dot
 * folders, like a comment, is never pending.
 */
export async function pendingRevisionCount(vaultPath: string, sharing = true): Promise<number> {
	const head = await headCommit(vaultPath).catch(() => null);
	if (!head) return 0;
	// The marker as the committed shared reports set it (REP-49, CMP-90), or the local tag with sharing off (CFG-44).
	const from = await markerCommit(vaultPath, sharing);
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

const QUESTIONS_SCHEMA = {
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
				description: "Where in the model the rule that needs updating sits: the file, its heading and a short quote of the rule.",
				items: ANCHOR_SCHEMA,
			},
		},
		required: ["question", "notes"],
	},
};

const PROBLEMS_SCHEMA = {
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
};

/** A compile's answer (CMP-15): the plan instead of changes, because a compile changes no code. */
export const COMPILE_SCHEMA = {
	type: "object",
	properties: {
		status: { type: "string", enum: ["succeeded", "failed"] },
		summary: { type: "string", description: "What this compile planned, in two or three sentences." },
		plan: PLAN_SCHEMA,
		questions: QUESTIONS_SCHEMA,
		problems: PROBLEMS_SCHEMA,
	},
	required: ["status", "summary", "plan", "questions", "problems"],
};

/** A build's answer for one issue. */
export const BUILD_SCHEMA = {
	type: "object",
	properties: {
		status: { type: "string", enum: ["succeeded", "failed"] },
		summary: { type: "string", description: "What this build did, in two or three sentences. It opens the pull request's body." },
		changes: { type: "array", items: { type: "string" }, description: "Each change made to the code." },
		questions: QUESTIONS_SCHEMA,
		problems: PROBLEMS_SCHEMA,
	},
	required: ["status", "summary", "changes", "questions", "problems"],
};

/** The fields an answer must have, else it counts as no structured answer (CMP-17, AGT-10). */
export function requiredFields(schema: { required: string[] }): string[] {
	return schema.required;
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

/** The model diff Claude receives: each change with its whole section, or three lines when that is too long (CMP-10, CMP-11). */
export async function modelDiff(vaultPath: string, from: string | null, to: string): Promise<string> {
	return limitedDiff(await readModelDiff(vaultPath, from ?? EMPTY_TREE, to, NOT_SENT), MAX_DIFF_CHARS);
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

/** The `instructions.md` in a repository's model folder, matched ignoring case, or null when it has none. */
async function modelInstructions(snapshot: string, repo: string): Promise<{ path: string; text: string } | null> {
	const folder = join(snapshot, repo);
	const entries = await readdir(folder).catch(() => [] as string[]);
	const name = entries.find((entry) => entry.toLowerCase() === "instructions.md");
	if (!name) return null;
	const text = await readFile(join(folder, name), "utf8").catch(() => null);
	return text === null ? null : { path: `${repo}/${name}`, text };
}

/** The git repositories in the project folder, as the prompt names them. */
function repoListText(projectFolder: string): string {
	const found = findProjectRepos(projectFolder);
	return found.kind === "root"
		? `The project folder is a single git repository, named ${basename(projectFolder)}.`
		: found.kind === "children"
			? `Git repositories in the project folder:\n${found.repos.map((repo) => `- ${relative(projectFolder, repo)}`).join("\n")}`
			: "The project folder has no git repositories yet.";
}

function revisionListText(revisions: Revision[]): string {
	return revisions.map((r) => `- ${r.hash.slice(0, 7)} ${r.date} ${r.author}: ${r.subject}`).join("\n");
}

/**
 * The earlier compile's issues that are still open, for a recompile (CMP-76): those it created, not discarded, and
 * open on GitHub now. Throws when GitHub can't say, so the recompile can't start rather than plan from a guess.
 */
export async function openEarlierIssues(github: GitHub, earlier: CompileReport): Promise<IssueRecord[]> {
	const open: IssueRecord[] = [];
	for (const record of earlier.issues ?? []) {
		if (record.number === undefined || record.discarded) continue;
		let state: "open" | "closed";
		try {
			state = await github.issueState(record.repoPath, record.number);
		} catch (error) {
			throw new Error(`Couldn't check ${record.repo}#${record.number} on GitHub: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (state === "open") open.push(record);
	}
	// REP-50: an earlier compile read from `.compiles/` has no issue bodies. The prompt and CMP-80 need them.
	await fillIssueBodies(github, open);
	return open;
}

/** The earlier compile's open issues as the prompt lists them (CMP-76): number, repository, kind, title, body, rules and short name. */
function earlierIssuesText(issues: IssueRecord[]): string {
	if (issues.length === 0) return "None of the earlier compile's issues is still open, so every issue in your plan is new.";
	return issues
		.map((i) =>
			[
				`### #${i.number}: ${i.title}`,
				"",
				`- Repository: ${i.repo}`,
				`- Kind: ${i.kind}`,
				`- Rules: ${i.rules.join(", ")}`,
				`- Short name: ${i.shortName}`,
				"",
				i.body.trim(),
			].join("\n"),
		)
		.join("\n\n");
}

/** The prompt of a compile: the rules of CMP-12 and what CMP-10 says Claude receives. */
export function compilePrompt(params: {
	snapshot: string;
	projectFolder: string;
	/** The code snapshot, and what each repository in it was read at (CMP-10, CMP-84). */
	codeSnapshot: string;
	code: CodeRead[];
	head: string;
	from: string | null;
	revisions: Revision[];
	diff: string;
	instructions: { repo: string; path: string; text: string }[];
	/** For a recompile: the earlier compile's issues that are still open (CMP-76). `from` is then that compile's start. */
	earlier?: IssueRecord[];
	/** The repositories this compile may plan issues in (CMP-96, CMP-97). */
	scope?: string[];
	/** The rule map, as `ruleMapText` writes it (CMP-94, CMP-95). */
	ruleMap?: string;
	/** The fixed context, as `fixedContextText` writes it (CMP-106). */
	fixedContext?: string;
}): string {
	const { snapshot, projectFolder, codeSnapshot, code, head, from, revisions, diff, instructions, earlier, scope, ruleMap, fixedContext } = params;
	const instructionList = instructions
		.map((i) => `### ${i.repo} (${i.path} in the model directory)\n\n${i.text.trim()}`)
		.join("\n\n");
	return `You are compiling a theoretical model into a plan of work.

The theoretical model is a set of notes, written only by humans, that describes a software ecosystem: what it does and why. Your job is to read the model and the code in the code snapshot (the current directory), and plan the work that makes the code match the model. You don't change any code: the plugin creates your plan as GitHub issues, and a later build writes the code, one issue at a time.

The model at revision ${head} is in this directory: ${snapshot}

${repoListText(projectFolder)}

${
		code.length > 0
			? `The code is in this directory, one folder per repository under the same name: ${codeSnapshot}
It is each repository's default branch as \`origin\` has it, read at:
${code.map((read) => `- ${codeReadText(read)}`).join("\n")}`
			: `The code snapshot is empty, because the project folder has no git repositories yet: ${codeSnapshot}`
	}

Rules:
- The model is read-only. Never create, edit, move or delete anything in the model directory, and never write to the Obsidian vault it came from. Writing to the model is forbidden.
- The model is the source of truth. If the code disagrees with the model, the code changes.
- A note whose front matter has \`realized: false\` is written ahead of the code. Don't plan what it describes yet, and don't count it as a mismatch.
- If the model is unclear, incomplete or contradicts itself, don't guess. Add a question to \`questions\`, naming the model files it is about with paths relative to the model directory. Give it \`anchors\` pointing at the rule that needs updating: the model file, the heading it sits under, and a short quote of the rule copied exactly from the note. Carry on with the parts that are clear.
- Read the code only in the code snapshot. It is each repository's default branch as \`origin\` has it. Never change a file anywhere: you can only read, search and list.
- Notes at the root of the model directory describe the whole system. Notes in a folder named after a repository describe that repository only.
- Before planning work in a repository, follow its AGENTS.md and CLAUDE.md, given below in the fixed context, and \`instructions.md\` in that repository's folder in the model directory, given below too, so the issues fit how that repository is built and tested.
- Plan one issue, or an epic with sub-issues. It is one issue when all the work changes one repository and carries one intent. Otherwise it is an epic, with one sub-issue for each repository and intent. Leave \`plan.issues\` empty when the code already matches the model.
- List sub-issues in build order: work that other sub-issues depend on comes first. They are built one at a time, each on top of the last.
- Every issue says what to build and why, in the model's words. It lists the rule IDs it covers in \`rules\`. Those rules are its acceptance criteria.
- Every issue changes exactly one repository. Name it in \`repo\` as it is named above.
- In a recompile, continue an earlier issue whenever the same work is still asked for in the same repository, even when its title, body or rules change: plan all the work again, then match it to the earlier issues. To continue one, set \`continues\` to its number, and say in \`changed\`, in one sentence, what changed and why, like "Now names the description of each check, answered in STAT-10." An epic continues only an earlier epic, and an issue (a sub-issue too) only an earlier issue in the same repository. Each earlier issue is continued at most once. A new issue is only for work no earlier issue covers. Outside a recompile, never set \`continues\`.
- A title is a short sentence in the imperative, under 70 characters, like "Show a diff for each file on the Commit page".
- A short name says what changes, like \`commit-page-diffs\`. It uses lowercase letters, digits and dashes only, and has at most 40 characters. Branches are named from it. No two short names in one plan are the same, the epic's included.
- Put anything that went wrong (steps you couldn't do) in \`problems\`.
- When a problem comes from something in the model, give it \`anchors\`: the model file, the heading it sits under, and a short quote copied exactly from the note (under 200 characters). Engineers see these as highlights in the note. Leave \`anchors\` empty when the problem isn't about the model.
- Set \`status\` to "failed" if you can't plan the work.
- Never create issues, branches or pull requests, and never touch GitHub.
- Read only the lines you need of a file longer than 400 lines, starting from the rule map or a search. Read a long file in full only when the lines you need are spread across it, and never read the same lines twice: a long file read in full is paid for in every later step.
- An issue's body says what changes and why, in the model's words, in at most 150 words. It lists the rule IDs it covers and never repeats their text: the build reads the rules from the model.
${instructionList ? `\n## Instructions for each repository\n\n${instructionList}\n` : ""}${fixedContext ? `\n## Fixed context\n\n${fixedContext}\n` : ""}${scope ? `\n## Scope\n\n${scopeText(scope)}\n` : ""}${ruleMap ? `\n## Rule map\n\n${ruleMap}\n` : ""}
${
		earlier
			? `## This is a recompile

It plans again the work of an earlier compile, whose issues haven't been built yet. The revisions and the changes below start where that compile started, so they cover its revisions and every revision since.

${from ? `The earlier compile started from revision ${from}.` : "The earlier compile was the first compile, so the whole model is new."}

## The earlier compile's open issues

${earlierIssuesText(earlier)}

## Revisions since the earlier compile started`
			: `## Revisions since the last compile

${from ? `Last compiled revision: ${from}` : "This is the first compile, so the whole model is new."}`
	}

${revisionListText(revisions)}

## Changes to the model

Each change is shown with the whole section it sits in, from the heading above it to the next heading of the same or a higher level.

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

/** The summary when Claude Code fails to sign in (CMP-54). */
export const SIGN_IN_SUMMARY = "Claude Code isn't signed in. Run claude in a terminal, then /login.";

/** True when Claude Code's answer or error output says it couldn't sign in (CMP-54). */
export function signInFailed(output: string): boolean {
	return /not logged in|please run \/login|invalid api key|oauth token (?:has )?expired|authentication_error|failed to authenticate/i.test(
		output,
	);
}

/** The agent's answer in the shape of COMPILE_SCHEMA or BUILD_SCHEMA (CMP-15). */
export interface StructuredAnswer {
	status: "succeeded" | "failed";
	summary: string;
	/** A build's changes. */
	changes?: string[];
	/** A compile's plan, checked by `readPlan` before anything is created. */
	plan?: unknown;
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
export function acpAnswerInstructions(schema: object = COMPILE_SCHEMA): string {
	return `
## Your answer

When you are done, end your last message with your answer as one JSON block in a \`\`\`json fence. It must match this JSON Schema:

\`\`\`json
${JSON.stringify(schema, null, 2)}
\`\`\`
`;
}

/** Adds a line to the report's activity log, keeping the last 500 lines. */
export function appendLog(report: { log: string[] }, line: string) {
	report.log.push(line);
	if (report.log.length > MAX_LOG_LINES) report.log.shift();
}

/** One run of the agent, for a compile or for one issue of a build. */
export interface SessionParams {
	settings: AgentSettings;
	/** Where the agent runs: the project folder for a compile, the issue's repository for a build. */
	cwd: string;
	snapshot: string;
	/** The vault and the snapshot: the agent may never write to them. */
	protectedPaths: string[];
	prompt: string;
	schema: { required: string[] };
	/** True for a compile: only tools that read, and every other tool denied without a card (CMP-13). */
	readOnly: boolean;
	/** "compile" or "build", for the messages. */
	what: "compile" | "build";
	/** Where the activity log goes, and the token parts unless `usageTo` is set. */
	report: { log: string[]; tokens?: TokenUsage | number };
	/** Where the token parts go instead of `report`: a build's go to its build record, apart from the compile's (REP-56). */
	usageTo?: { tokens?: TokenUsage | number };
	onUpdate: () => void;
	onPermissionRequest?: (request: PermissionRequest) => void;
}

export interface AgentSession {
	done: Promise<AgentOutcome & { skipped: string[] }>;
	/** Permission requests waiting for an answer, oldest first. */
	requests: PermissionRequest[];
	/** Answers one request. Each request is answered on its own, never in bulk. */
	answer(id: string, answer: PermissionAnswer): void;
	cancel(): void;
}

/**
 * Starts the agent with the permission cards of CMP-27 to CMP-35. Throws when the agent can't even be spawned.
 * Every step that didn't run because of a denial or a timeout is in `skipped` once the run is done.
 */
export function startSession(params: SessionParams): AgentSession {
	const { report, settings } = params;
	const agent: CompileAgent = settings.agent ?? "claude";
	const requests: PermissionRequest[] = [];
	const log = (line: string) => {
		report.log.push(line);
		if (report.log.length > MAX_LOG_LINES) {
			report.log.shift();
			for (const request of requests) request.line--;
		}
		params.onUpdate();
	};

	type Respond = (choice: PermissionAnswer | "cancelled", message: string) => void;
	const pending = new Map<string, { respond: Respond; timer: ReturnType<typeof setTimeout> }>();
	// Steps that didn't run because a request was denied or timed out. Each becomes a problem.
	const skipped: string[] = [];
	const who = agent === "acp" ? "The agent" : "Claude";

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
		params.onUpdate();
		return request ? { request, respond: open.respond } : null;
	};

	const answer = (id: string, choice: PermissionAnswer) => {
		const closed = close(id, choice === "deny" ? "Denied" : choice === "always" ? "Always allowed" : "Allowed");
		if (!closed) return;
		const { request, respond } = closed;
		if (choice === "deny") {
			skipped.push(`You denied ${request.tool}: ${request.target}. ${who} carried on without it.`);
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
				skipped.push(`Nobody answered the request for ${step} within 120 seconds, so it was denied. ${who} carried on without it.`);
				respond("deny", "Nobody answered in time, so this was denied. Carry on without this step and name it in problems.");
			}, PERMISSION_TIMEOUT_MS);
			pending.set(permission.id, { respond, timer });
			requests.push(permission);
			// The card shows on this line until it's answered.
			log(`Asking: ${permission.target}`);
			params.onPermissionRequest?.(permission);
		},
		withdraw: (id) => void close(id, "Withdrawn"),
		skip: (problem) => void skipped.push(problem),
		closeAll: (message) => denyAll(message),
	};

	const run: AgentRun =
		agent === "acp"
			? runAcpAgent(
					{
						command: settings.agentCommand ?? "",
						projectFolder: params.cwd,
						snapshot: params.snapshot,
						protectedPaths: params.protectedPaths,
						// Same prompt as Claude Code, plus the answer's shape, since ACP has none built in.
						prompt: params.prompt + acpAnswerInstructions(params.schema),
						model: settings.agentModel ?? "",
						thinkingLevel: settings.agentThinkingLevel ?? "",
						required: params.schema.required,
						readOnly: params.readOnly,
					},
					host,
				)
			: runClaudeCode(params, host);
	const agentName = agent === "acp" ? "The agent" : "Claude Code";

	return {
		done: run.done.then((outcome) => {
			denyAll(`${agentName} exited`);
			return { ...outcome, skipped };
		}),
		requests,
		answer,
		cancel() {
			// An ACP agent hears its open requests were cancelled (AGT-18); Claude Code hears they were denied.
			denyAll(`the ${params.what} was cancelled`, agent === "acp" ? "cancelled" : "deny");
			run.cancel();
		},
	};
}

/** The text of a problem when the agent couldn't be started (CMP-19, AGT-19). */
export function startProblem(error: Error, settings: AgentSettings): string {
	if ((error as NodeJS.ErrnoException).code !== "ENOENT") return error.message;
	return settings.agent === "acp"
		? `Couldn't find the agent ("${settings.agentCommand}"). Set its command in theory.md settings.`
		: `Couldn't find the Claude Code CLI ("${settings.claudeCommand}"). Set its path in theory.md settings.`;
}

/** The problem when the agent gave no structured answer (CMP-17, AGT-22). */
export function noAnswerProblem(outcome: AgentOutcome, settings: AgentSettings): string {
	return settings.agent === "acp"
		? // The plugin stops an ACP agent itself, so its exit code means nothing (AGT-22).
			`The agent gave no structured answer. It stopped because: ${(outcome.stopReason ?? "unknown").replace(/\.$/, "")}. ${outcome.stderr.trim()}`.trim()
		: `Claude Code exited with code ${outcome.code}. ${outcome.stderr.trim()}`.trim();
}

/** The snapshot hash and the vault's working tree before the agent ran, to check the model came back as it went in. */
export interface ModelGuard {
	snapshot: string;
	snapshotHash: string;
	vaultPath: string;
	vaultBefore: Map<string, string>;
}

export async function guardModel(vaultPath: string, snapshot: string): Promise<ModelGuard> {
	return { snapshot, snapshotHash: await hashTree(snapshot), vaultPath, vaultBefore: await workingTreeState(vaultPath) };
}

/**
 * The snapshot check (INV-5) and the vault check (INV-6). They run after every run in which an agent started,
 * cancelled ones included, whatever the agent, because an agent's own shell can write anywhere the engineer
 * can (AGT-17, INV-12).
 */
export async function checkModel(guard: ModelGuard, what: "compile" | "build" = "compile"): Promise<{ intact: boolean; problems: Problem[] }> {
	const intact = (await hashTree(guard.snapshot).catch(() => "")) === guard.snapshotHash;
	const vaultAfter = await workingTreeState(guard.vaultPath).catch(() => guard.vaultBefore);
	// A file that was dirty before and is clean now changed too, so compare both ways.
	const paths = new Set([...guard.vaultBefore.keys(), ...vaultAfter.keys()]);
	const touched = [...paths].filter((path) => guard.vaultBefore.get(path) !== vaultAfter.get(path));
	const problems = [
		...(touched.length > 0
			? [plainProblem(`These vault files changed while the ${what} ran: ${touched.join(", ")}. If you didn't edit them, revert them.`)]
			: []),
		...(intact ? [] : [plainProblem("Claude tried to change the model snapshot. Those changes were thrown away.")]),
	];
	return { intact, problems };
}

/** Questions from the answer, with their anchors checked against the snapshot when it is still intact. */
export async function checkedQuestions(structured: StructuredAnswer | undefined, snapshot: string | null): Promise<Question[]> {
	const questions: Question[] = [];
	for (const q of structured?.questions ?? []) {
		const question: Question = { question: q.question, notes: (q.notes ?? []).map((note) => note.replace(/^\.?\//, "")) };
		const anchors = await checkAnchors(snapshot, q.anchors);
		if (anchors.length > 0) question.anchors = anchors;
		questions.push(question);
	}
	return questions;
}


export interface CompileRun {
	report: CompileReport;
	done: Promise<CompileReport>;
	/** Permission requests waiting for an answer. A compile denies without asking (CMP-13), so this stays empty. */
	requests: PermissionRequest[];
	answer(id: string, answer: PermissionAnswer): void;
	cancel(): void;
	/** After a GitHub step failed: Retry carries on from there (CMP-68, CMP-81). */
	retryIssues(): void;
	/**
	 * After a GitHub step failed: Discard closes the issues already created as not planned (CMP-68). Does nothing
	 * once an earlier issue changed on GitHub (CMP-81).
	 */
	discardIssues(): void;
}

/** The messages of the GitHub checks before a compile (CMP-55 to CMP-57), without "Compile failed: ". */
export const GH_LOGIN = "Log in to GitHub first. Run gh auth login in a terminal.";
export const NO_PROJECT = "Choose the GitHub Project in theory.md settings first.";

/**
 * The GitHub checks a compile and a build share: `gh` logged in (CMP-55), every repository with a GitHub `origin`
 * (CMP-56), and the GitHub Project set and reachable (CMP-57). Throws the first that fails.
 */
export async function requireGitHub(github: GitHub, cwd: string, repos: { name: string; path: string }[], projectUrl: string) {
	if (await github.authProblem(cwd)) throw new Error(GH_LOGIN);
	const missing: string[] = [];
	for (const repo of repos) if (!(await github.repoName(repo.path).catch(() => null))) missing.push(repo.name);
	if (missing.length > 0) throw new Error(`These repositories have no GitHub origin: ${missing.join(", ")}.`);
	if (!projectUrl.trim()) throw new Error(NO_PROJECT);
	try {
		await github.checkProject(projectUrl.trim(), cwd);
	} catch (error) {
		throw new Error(`Couldn't reach the GitHub Project ${projectUrl.trim()}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** The problem when the code snapshot changed while the agent ran (INV-14). */
export const CODE_SNAPSHOT_CHANGED = "Claude tried to change the code snapshot. Those changes were thrown away.";

/** Each repository's branch and commit, to check a compile changed none of them (CMP-69). */
async function codeState(projectFolder: string): Promise<Map<string, string>> {
	const state = new Map<string, string>();
	for (const repo of projectRepos(projectFolder)) {
		const refs = await git(repo.path, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]).catch(() => ({ stdout: "" }));
		const head = await git(repo.path, ["rev-parse", "--symbolic-full-name", "HEAD"]).catch(() => ({ stdout: "" }));
		const status = await git(repo.path, ["status", "--porcelain", "--untracked-files=all"]).catch(() => ({ stdout: "" }));
		state.set(repo.name, `${head.stdout.trim()}\n${refs.stdout.trim()}\n${status.stdout.trim()}`);
	}
	return state;
}

/**
 * Starts a compile of every vault revision committed since the last compile. Claude only reads and plans; the
 * plugin then creates the plan as GitHub issues. Throws before anything runs when the compile can't start;
 * after that, every outcome is recorded in the returned report.
 */
export async function startCompile(options: CompileOptions, onUpdate: (report: CompileReport) => void): Promise<CompileRun> {
	const { vaultPath, projectFolder } = options;
	const github = options.github ?? ghGitHub;
	const agent: CompileAgent = options.agent ?? "claude";
	if (!projectFolder) throw new Error("Choose the project folder in theory.md settings first.");
	if (!existsSync(projectFolder) || !statSync(projectFolder).isDirectory()) {
		throw new Error(`The project folder doesn't exist: ${projectFolder}`);
	}
	if (agent === "acp" && !options.agentCommand?.trim()) {
		throw new Error("Set the agent command in theory.md settings first.");
	}

	const head = await headCommit(vaultPath);
	// The marker as the shared reports set it after the pull before this compile (CMP-90), or the local tag with
	// Share compile reports off (CFG-44).
	const sharing = options.shareReports !== false;
	const marker = await markerCommit(vaultPath, sharing);
	if (marker === head || (await pendingRevisionCount(vaultPath, sharing)) === 0) {
		throw new NothingToCompileError("Every committed revision is already compiled.");
	}
	// Claude plans from the committed code, never from the engineer's unfinished work (CMP-36).
	const dirty = await dirtyRepos(projectFolder);
	if (dirty.length > 0) {
		throw new Error(`These repositories have uncommitted changes: ${dirty.join(", ")}. Commit or stash them first.`);
	}
	const repos = projectRepos(projectFolder);
	await requireGitHub(github, projectFolder, repos, options.githubProject);
	// A build may have started since the report was drawn: CMP-73 is checked again, last (CMP-75).
	if (options.recompile) {
		const reason = await recompileProblem(options.recompile, options.reports ?? []);
		if (reason) throw new Error(reason);
	}

	// A recompile starts where the earlier compile started, and gets its issues that are still open (CMP-76).
	const earlier = options.recompile;
	const from = earlier ? earlier.fromCommit : marker;
	const openEarlier = earlier ? await openEarlierIssues(github, earlier) : undefined;

	const revisions = await revisionsBetween(vaultPath, from, head);
	const changes = await readModelDiff(vaultPath, from ?? EMPTY_TREE, head, NOT_SENT);
	const diff = limitedDiff(changes, MAX_DIFF_CHARS);
	// The changed rules (CMP-92) and the scope they and the changed notes make (CMP-96).
	const rules = changedRules(changes.files);
	const scope = compileScope(repos.map((r) => r.name), changes.files, rules, openEarlier ?? []);
	const notes = await changedNotes(vaultPath, from, head);
	const codeBefore = await codeState(projectFolder);
	// Claude reads each repository's default branch as origin has it, never the checkout (CMP-84). Throws when one
	// can't be read, before anything else is made (CMP-88).
	const fetched = new Set(options.fetched ?? repos.map((r) => r.path));
	const code: CodeSnapshot = await createCodeSnapshot(repos, github, fetched);
	let snapshot: string | null = null;
	let guard: ModelGuard;
	let codeHash: string;
	const instructions: { repo: string; path: string; text: string }[] = [];
	let mapText: string;
	let fixedText: string;
	try {
		snapshot = await createSnapshot(vaultPath, head);
		guard = await guardModel(vaultPath, snapshot);
		codeHash = await hashTree(code.dir);
		for (const repo of repos) {
			const file = await modelInstructions(snapshot, repo.name);
			if (file) instructions.push({ repo: repo.name, ...file });
		}
		// The files git tracks in each repository, at the commit the code snapshot holds (CMP-93, CMP-106).
		const tracked = await Promise.all(
			code.code.map(async (read) => {
				const repo = repos.find((r) => r.name === read.repo);
				return { name: read.repo, files: repo ? await trackedFiles(repo.path, read.commit) : [] };
			}),
		);
		mapText = ruleMapText(ruleMap(rules, await searchRules([...new Set(rules.map((r) => r.id))], code.dir, tracked)));
		fixedText = fixedContextText(await fixedParts(snapshot, code.dir, tracked.filter((repo) => scope.includes(repo.name))));
	} catch (error) {
		// Both snapshots go whatever the outcome (INV-7, CMP-89).
		if (snapshot) await removeSnapshot(snapshot);
		await removeSnapshot(code.dir);
		throw error;
	}
	const modelSnapshot = snapshot;

	const report: CompileReport = {
		id: `${Date.now()}`,
		status: "running",
		startedAt: new Date().toISOString(),
		fromCommit: from,
		...(earlier
			? { recompileOf: earlier.id, earlier: { startedAt: earlier.startedAt, fromCommit: earlier.fromCommit, toCommit: earlier.toCommit } }
			: {}),
		toCommit: head,
		revisions,
		code: code.code,
		summary: "",
		changes: [],
		questions: [],
		problems: [],
		log: [],
		author: options.author,
		...(options.authorEmail ? { authorEmail: options.authorEmail } : {}),
		...(agent === "acp" ? { agent } : {}),
		model: agent === "acp" ? (options.agentModel ?? "") : options.model,
		effort: agent === "acp" ? (options.agentThinkingLevel ?? "") : options.effort,
	};

	let session: AgentSession;
	try {
		session = startSession({
			settings: options,
			// The agent runs in the code snapshot, whichever agent it is (CMP-13), and may write to none of these (INV-4, INV-14).
			cwd: code.dir,
			snapshot: modelSnapshot,
			protectedPaths: [vaultPath, modelSnapshot, code.dir],
			prompt: compilePrompt({
				snapshot: modelSnapshot,
				projectFolder,
				codeSnapshot: code.dir,
				code: code.code,
				head,
				from,
				revisions,
				diff,
				instructions,
				earlier: openEarlier,
				scope,
				ruleMap: mapText,
				fixedContext: fixedText,
			}),
			schema: COMPILE_SCHEMA,
			readOnly: true,
			what: "compile",
			report,
			onUpdate: () => onUpdate(report),
			onPermissionRequest: options.onPermissionRequest,
		});
	} catch (error) {
		await removeSnapshot(modelSnapshot);
		await removeSnapshot(code.dir);
		throw error;
	}
	const agentName = agent === "acp" ? "The agent" : "Claude Code";

	let cancelled = false;
	// Set while the report waits for Retry or Discard (CMP-68).
	let choose: ((choice: "retry" | "discard" | "stop") => void) | null = null;
	// The marker moves when the shared report is committed with `markerMoved: true` (CMP-22, REP-49).
	const markCompiled = () => {
		report.markerMoved = true;
	};
	const share = async () => {
		await options.share?.(report, { model: modelSnapshot, code: code.dir }).catch(() => {});
	};

	const done = (async () => {
		const outcome = await session.done;
		const { result, error, stderr } = outcome;
		let snapshotGone = false;
		const dropSnapshot = async () => {
			if (snapshotGone) return;
			snapshotGone = true;
			await removeSnapshot(modelSnapshot);
		};
		try {
			const checked = await checkModel(guard);
			// The code snapshot is checked as the model snapshot is, after every run in which the agent started (INV-14).
			const codeIntact = (await hashTree(code.dir).catch(() => "")) === codeHash;
			if (!codeIntact) checked.problems.push(plainProblem(CODE_SNAPSHOT_CHANGED));
			// A compile never changes code (CMP-69): anything that did is the agent's own shell, and the engineer must hear.
			const codeAfter = await codeState(projectFolder).catch(() => codeBefore);
			const changedRepos = [...codeBefore.keys()].filter((name) => codeBefore.get(name) !== codeAfter.get(name));
			const codeProblems = changedRepos.length
				? [plainProblem(`These repositories changed during the compile: ${changedRepos.join(", ")}. A compile never changes code, so check them.`)]
				: [];
			if (cancelled) {
				report.status = "cancelled";
				report.summary = "You cancelled this compile. The last compile marker didn't move.";
				report.problems.unshift(...checked.problems, ...codeProblems);
				return report;
			}
			if (error) {
				report.status = "failed";
				report.summary = `${agent === "acp" ? "The agent" : "Claude Code"} couldn't be started.`;
				report.problems.push(plainProblem(startProblem(error, options)));
				report.problems.unshift(...checked.problems, ...codeProblems);
				return report;
			}
			// Claude Code that can't sign in never read the revisions, so the compile couldn't start (CMP-54).
			if (agent !== "acp" && !result?.structured && signInFailed(`${result?.text ?? ""}\n${stderr}`)) {
				report.status = "failed";
				report.summary = SIGN_IN_SUMMARY;
				report.problems.unshift(...checked.problems, ...codeProblems);
				return report;
			}

			report.suspectNotes = notes;
			const structured = result?.structured;
			let claimedProblems: unknown = [];
			let plan = null;
			const planProblems: string[] = [];
			// The report stays running until every issue exists (CMP-16): the view shows Retry and Discard, and
			// Cancel works, only while it runs.
			let verdict: "succeeded" | "failed";
			if (structured) {
				verdict = structured.status === "succeeded" && !result?.isError ? "succeeded" : "failed";
				report.summary = structured.summary;
				claimedProblems = structured.problems;
				if (verdict === "succeeded") {
					const read = readPlan(structured.plan, repos.map((r) => r.name), openEarlier ?? null, scope);
					plan = read.plan;
					planProblems.push(...read.problems);
					if (!plan) verdict = "failed";
				}
			} else {
				verdict = "failed";
				report.summary = result?.text || `${agentName} finished without a report.`;
				report.problems.push(plainProblem(noAnswerProblem(outcome, options)));
			}

			// Anchors are only checked when neither snapshot changed (INV-5, INV-14).
			const intact = checked.intact && codeIntact;
			report.problems.push(...(await checkProblems(intact ? modelSnapshot : null, claimedProblems)));
			report.problems.push(...planProblems.map(plainProblem));
			// The engineer must know which steps didn't run, whatever Claude reported.
			report.problems.push(...outcome.skipped.map(plainProblem));
			report.questions = await checkedQuestions(structured, intact ? modelSnapshot : null);
			if (!intact || changedRepos.length > 0) verdict = "failed";
			report.problems.unshift(...checked.problems, ...codeProblems);
			await dropSnapshot();

			if (verdict !== "succeeded" || !plan) {
				// A failed compile creates no issue, and the marker still moves (CMP-17, CMP-22).
				report.status = "failed";
				markCompiled();
				return report;
			}

			const empty = isEmptyPlan(plan);
			// The plugin, never Claude, brings GitHub in line with the plan, only once it passed CMP-70 (CMP-63, CMP-80).
			// A recompile's records are copies: the earlier report stays as it was (CMP-82).
			report.issues = empty ? [] : issueRecords(plan, new Map(repos.map((r) => [r.name, r.path])), earlier?.issues ?? []);
			if (openEarlier) report.closing = closingIssues(openEarlier, report.issues);
			if (report.issues.length === 0 && !report.closing?.length) {
				// Nothing to build: the code already matches the model. No issue, no Build, and the marker moves (CMP-71).
				report.status = "succeeded";
				markCompiled();
				return report;
			}
			// Claude ran, so a compile's marker moves (CMP-22). A recompile's moves once every step is done (CMP-81).
			if (!earlier) markCompiled();
			onUpdate(report);
			const what = earlier ? "recompile" : "compile";
			for (;;) {
				try {
					await syncIssues(github, report.issues, report.closing ?? [], revisions, head, options.githubProject.trim(), () => onUpdate(report));
					delete report.issueFailure;
					break;
				} catch (failure) {
					const prefix = failure instanceof SyncError ? SYNC_FAILURE[failure.step] : SYNC_FAILURE.create;
					report.issueFailure = `${prefix}: ${failure instanceof Error ? failure.message : String(failure)}`;
					const answered = cancelled
						? Promise.resolve<"stop">("stop")
						: new Promise<"retry" | "discard" | "stop">((resolve) => (choose = resolve));
					onUpdate(report);
					// The compile Claude ran is shared while it waits; Retry and Discard update it (REP-46). A recompile
					// is shared once it ends.
					if (!earlier && !cancelled) await share();
					const choice = await answered;
					choose = null;
					if (choice === "retry" && !cancelled) continue;
					const reason = report.issueFailure;
					delete report.issueFailure;
					if (!canDiscard(report.issues, report.closing)) {
						// An edit on GitHub can't be undone, so nothing is closed, and the marker waits for every step (CMP-81).
						const left = stepsLeft(report.issues, report.closing);
						report.markerMoved = false;
						report.status = cancelled ? "cancelled" : "failed";
						if (cancelled) report.summary = `You cancelled this ${what}. The last compile marker didn't move.`;
						report.problems.push(
							plainProblem(`${reason} GitHub doesn't match the plan yet, and the last compile marker didn't move. Still to do: ${left.join(" ")}`),
						);
						return report;
					}
					// A GitHub failure says nothing about the model: the revisions stay pending (CMP-68).
					const notClosed = await discardIssues(github, report.issues);
					// Discard commits the report again with `markerMoved: false` (CMP-22, CMP-68).
					report.markerMoved = false;
					report.status = cancelled ? "cancelled" : "failed";
					if (cancelled) report.summary = `You cancelled this ${what}. The last compile marker didn't move.`;
					report.problems.push(
						plainProblem(`${reason} The issues already created were closed as not planned, and the last compile marker didn't move.`),
						...notClosed.map(plainProblem),
					);
					return report;
				}
			}
			report.status = "succeeded";
			markCompiled();
			return report;
		} finally {
			report.finishedAt = new Date().toISOString();
			await dropSnapshot();
			// The code snapshot goes whatever the outcome (CMP-89).
			await removeSnapshot(code.dir).catch(() => {});
			// The compile ended: its shared report is committed when Claude ran (REP-46).
			await share();
			onUpdate(report);
		}
	})();

	return {
		report,
		done,
		requests: session.requests,
		answer: session.answer,
		cancel() {
			if (report.status !== "running" || cancelled) return;
			cancelled = true;
			// Waiting for Retry or Discard, Cancel discards (CMP-18: a cancelled compile creates no issue), unless an
			// earlier issue already changed, which can't be undone (CMP-81).
			if (choose) return choose("stop");
			session.cancel();
		},
		retryIssues: () => choose?.("retry"),
		discardIssues: () => {
			if (canDiscard(report.issues ?? [], report.closing)) choose?.("discard");
		},
	};
}


/** The tools a compile's Claude Code gets: reading files, searching and listing (CMP-13). */
export const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];

/** The arguments Claude Code runs with. A read-only run gets only READ_ONLY_TOOLS, and every other tool is denied without asking. */
export function claudeArgs(params: Pick<SessionParams, "settings" | "protectedPaths" | "snapshot" | "schema" | "readOnly">): string[] {
	const { settings, protectedPaths, snapshot, schema, readOnly } = params;
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
		readOnly ? "dontAsk" : settings.permissionMode,
	];
	if (readOnly) args.push("--tools", READ_ONLY_TOOLS.join(","), "--strict-mcp-config");
	args.push("--add-dir", snapshot, "--json-schema", JSON.stringify(schema), "--disallowedTools", ...disallowed);
	if (readOnly) args.push(...WRITE_TOOLS, "Bash");
	// Fixed when Claude Code starts, so a running compile keeps the model and effort it started with.
	if (settings.model) args.push("--model", settings.model);
	if (settings.effort) args.push("--effort", settings.effort);
	const allowed = readOnly ? READ_ONLY_TOOLS.join(" ") : settings.allowedTools.trim();
	if (allowed) args.push("--allowedTools", allowed);
	return args;
}

/** Runs Claude Code with `-p` and stream-json in `cwd` for one compile, or one issue of a build. */
function runClaudeCode(params: SessionParams, host: AgentHost): AgentRun {
	const { settings, protectedPaths, prompt, report, cwd, readOnly } = params;
	const usageTo = params.usageTo ?? report;
	// The model that ran, as Claude Code names it, so the cost uses its price (REP-57).
	let model: string | undefined;
	const child: ChildProcess = spawn(settings.claudeCommand || "claude", claudeArgs(params), {
		cwd,
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
		// A compile only reads: anything else is denied without a card (CMP-13).
		if (readOnly) {
			const target = requestTarget(tool, input);
			host.skip(`A compile only reads, so ${tool}: ${target} was denied.`);
			host.log(`Denied: ${target}`);
			deny(id, "A compile only reads the model and the code. Carry on without this step.");
			return;
		}
		const file = writtenFile(tool, input, cwd);
		// Writes to the model never reach a card.
		if (file && protectedPaths.some((dir) => isInside(file, dir))) {
			host.skip(`Claude tried to write to the model (${file}). That was denied.`);
			host.log(`Denied: ${file}`);
			deny(id, "Writing to the model is forbidden. Carry on without this step.");
			return;
		}
		const description = typeof input.description === "string" ? input.description : "";
		const reason = description || (typeof request.decision_reason === "string" ? request.decision_reason : "");
		const rules = requestRules(tool, input, cwd, request.permission_suggestions);
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
			if (event.type === "system" && event.subtype === "init" && typeof event.model === "string") {
				model = event.model;
			} else if (event.type === "assistant") {
				if (!model && typeof event.message?.model === "string") model = event.message.model;
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
				// REP-56: four parts, added to what this compile or build counted so far.
				const parts = claudeUsageParts(event.usage);
				if (parts) usageTo.tokens = addUsage(usageTo.tokens, parts, model);
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
