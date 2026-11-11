import { readFile } from "fs/promises";
import { join } from "path";
import { findRules } from "./rule-count";
import { type Change, type ChangeKind, git } from "./vault";

/** One line of a diff: removed, added or unchanged. Shown as raw text, never as Markdown (CMT-24). */
export interface DiffLine {
	kind: "del" | "add" | "ctx";
	text: string;
}

export interface Hunk {
	oldStart: number;
	newStart: number;
	/** Unchanged lines between the previous hunk (or the top of the file) and this one, folded away (CMT-20). */
	foldedBefore: number;
	lines: DiffLine[];
}

/** The rules a note adds, changes and removes, by ID (CMT-21). */
export interface RuleChanges {
	added: string[];
	changed: string[];
	removed: string[];
}

/** One file of a commit, new or past, with its diff (CMT-6, CMT-20 to CMT-22). */
export interface FileDiff {
	path: string;
	/** The path before a rename. */
	oldPath?: string;
	kind: ChangeKind;
	/** A file that isn't text shows only its name and how it changed (CMT-22). */
	binary: boolean;
	hunks: Hunk[];
	/** Null for files that aren't notes. */
	rules: RuleChanges | null;
}

/** Lines of context around each change (CMT-20). */
export const CONTEXT_LINES = 3;

const DIFF_ARGS = ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", `-U${CONTEXT_LINES}`];

/** True when git's diff says the file isn't text. */
export function isBinaryDiff(diff: string): boolean {
	return /^Binary files .* differ$/m.test(diff) || /^GIT binary patch$/m.test(diff);
}

/** The hunks of one file's unified diff, with the unchanged lines folded between them. */
export function parseHunks(diff: string): Hunk[] {
	const hunks: Hunk[] = [];
	let current: Hunk | null = null;
	// The old file's next line after the last hunk, counted from 1.
	let oldNext = 1;
	for (const line of diff.split("\n")) {
		const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (header) {
			const oldStart = Number(header[1]);
			const oldCount = header[2] === undefined ? 1 : Number(header[2]);
			// A hunk with no old lines starts after line `oldStart`, not at it.
			const firstOld = oldCount === 0 ? oldStart + 1 : oldStart;
			current = { oldStart, newStart: Number(header[3]), foldedBefore: Math.max(0, firstOld - oldNext), lines: [] };
			hunks.push(current);
			oldNext = firstOld + oldCount;
			continue;
		}
		if (!current) continue;
		if (line.startsWith("+")) current.lines.push({ kind: "add", text: line.slice(1) });
		else if (line.startsWith("-")) current.lines.push({ kind: "del", text: line.slice(1) });
		else if (line.startsWith(" ")) current.lines.push({ kind: "ctx", text: line.slice(1) });
		// "\ No newline at end of file" and the empty line after the last hunk carry no text.
	}
	return hunks;
}

/** Each rule's ID with the text it spans; an ID declared twice keeps both texts. */
function rulesById(text: string): Map<string, string> {
	const lines = text.split(/\r?\n/);
	const rules = new Map<string, string>();
	for (const rule of findRules(text)) {
		const id = `${rule.prefix}-${rule.number}`;
		const body = lines.slice(rule.line, rule.endLine + 1).join("\n").trim();
		rules.set(id, rules.has(id) ? `${rules.get(id)}\n${body}` : body);
	}
	return rules;
}

/** The rules a note adds, changes and removes, from its text before and after (CMT-21). Null text means no file. */
export function ruleChanges(before: string | null, after: string | null): RuleChanges {
	const old = rulesById(before ?? "");
	const next = rulesById(after ?? "");
	return {
		added: [...next.keys()].filter((id) => !old.has(id)),
		changed: [...next.keys()].filter((id) => old.has(id) && old.get(id) !== next.get(id)),
		removed: [...old.keys()].filter((id) => !next.has(id)),
	};
}

/** "Adds CMT-16. Changes CMT-7, CMT-8. Removes CMT-3.", or "" when no rule changed (CMT-21). */
export function ruleChangesLabel(rules: RuleChanges): string {
	const parts: string[] = [];
	if (rules.added.length > 0) parts.push(`Adds ${rules.added.join(", ")}.`);
	if (rules.changed.length > 0) parts.push(`Changes ${rules.changed.join(", ")}.`);
	if (rules.removed.length > 0) parts.push(`Removes ${rules.removed.join(", ")}.`);
	return parts.join(" ");
}

function isNote(path: string): boolean {
	return path.toLowerCase().endsWith(".md");
}

/** A file's text at a revision, or null when it isn't there. */
async function textAt(vaultPath: string, revision: string, path: string): Promise<string | null> {
	try {
		return (await git(vaultPath, ["show", `${revision}:${path}`])).stdout;
	} catch {
		return null;
	}
}

/** Git's diff output; `git diff --no-index` exits with 1 when the files differ. */
async function diffOutput(vaultPath: string, args: string[]): Promise<string> {
	try {
		return (await git(vaultPath, [...DIFF_ARGS, ...args])).stdout;
	} catch (error) {
		const failed = error as { code?: number; stdout?: string };
		if (failed.code === 1 && typeof failed.stdout === "string") return failed.stdout;
		throw error;
	}
}

function fileDiff(change: { path: string; oldPath?: string; kind: ChangeKind }, diff: string, before: string | null, after: string | null): FileDiff {
	const binary = isBinaryDiff(diff);
	return {
		path: change.path,
		...(change.oldPath ? { oldPath: change.oldPath } : {}),
		kind: change.kind,
		binary,
		hunks: binary ? [] : parseHunks(diff),
		rules: !binary && isNote(change.path) ? ruleChanges(before, after) : null,
	};
}

/**
 * One uncommitted change as the Commit page shows it: the file as it is now against the last commit
 * (CMT-20, CMT-23). Reads only; never writes to a note (CMT-24).
 */
export async function workingDiff(vaultPath: string, change: Change): Promise<FileDiff> {
	let diff: string;
	if (change.status === "??") diff = await diffOutput(vaultPath, ["--no-index", "--", "/dev/null", change.path]);
	else if (change.oldPath) diff = await diffOutput(vaultPath, ["-M", "HEAD", "--", change.oldPath, change.path]);
	else diff = await diffOutput(vaultPath, ["HEAD", "--", change.path]);
	const before = change.kind === "new" ? null : await textAt(vaultPath, "HEAD", change.oldPath ?? change.path);
	const after = change.kind === "deleted" ? null : await readFile(join(vaultPath, change.path), "utf8").catch(() => null);
	return fileDiff(change, diff, before, after);
}

/**
 * Which files a new Commit page ticks (CMT-19): only the note it was started from, or every file when the
 * floating bar started it with no note changed.
 */
export function initialTicks(changed: string[], from: string | "all"): string[] {
	return from === "all" ? [...changed] : changed.filter((path) => path === from);
}

/**
 * The ticks after the listed files changed (CMT-23): ticked files that are still changed stay ticked, and
 * a file that only now has changes starts unticked.
 */
export function keptTicks(ticked: string[], changed: string[]): string[] {
	return ticked.filter((path) => changed.includes(path));
}

/** A past commit, as the read-only Commit page shows it (CMT-26, CMT-27). */
export interface PastCommit {
	hash: string;
	shortHash: string;
	/** The commit's full message. */
	message: string;
	author: string;
	email: string;
	date: Date;
	files: FileDiff[];
}

const FIELD = "\x1f";

function kindOf(status: string): ChangeKind {
	if (status.startsWith("A") || status.startsWith("C")) return "new";
	if (status.startsWith("D")) return "deleted";
	if (status.startsWith("R")) return "renamed";
	return "modified";
}

/** Parses `--name-status -z` output into the files it lists. */
export function parseNameStatus(output: string): { path: string; oldPath?: string; kind: ChangeKind }[] {
	const parts = output.split("\0").filter((part) => part !== "");
	const files: { path: string; oldPath?: string; kind: ChangeKind }[] = [];
	for (let i = 0; i < parts.length; i++) {
		const status = parts[i];
		if (status.startsWith("R") || status.startsWith("C")) {
			const oldPath = parts[++i];
			const path = parts[++i];
			files.push(status.startsWith("R") ? { path, oldPath, kind: "renamed" } : { path, kind: "new" });
		} else {
			files.push({ path: parts[++i], kind: kindOf(status) });
		}
	}
	return files;
}

/**
 * A commit with its own diff against the commit before it, which never changes (CMT-27). The file at
 * `firstPath`, the note whose history was clicked, comes first (CMT-26).
 */
export async function pastCommit(vaultPath: string, hash: string, firstPath?: string): Promise<PastCommit> {
	const { stdout: meta } = await git(vaultPath, ["show", "-s", `--format=%H${FIELD}%h${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%B`, hash]);
	const [full, shortHash, author, email, date, ...message] = meta.split(FIELD);
	const parent = await git(vaultPath, ["rev-parse", "--verify", "--quiet", `${full}^1`]).then(
		({ stdout }) => stdout.trim(),
		() => null,
	);
	const { stdout: names } = parent
		? await git(vaultPath, ["-c", "core.quotePath=false", "diff", "--name-status", "-z", "-M", parent, full])
		: await git(vaultPath, ["-c", "core.quotePath=false", "diff-tree", "--root", "-r", "-M", "--no-commit-id", "--name-status", "-z", full]);

	const files: FileDiff[] = [];
	for (const file of parseNameStatus(names)) {
		const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
		const diff = parent
			? await diffOutput(vaultPath, ["-M", parent, full, "--", ...paths])
			: (await git(vaultPath, ["-c", "core.quotePath=false", "show", "--no-color", "--no-ext-diff", `-U${CONTEXT_LINES}`, "--format=", full, "--", ...paths])).stdout;
		const before = parent && file.kind !== "new" ? await textAt(vaultPath, parent, file.oldPath ?? file.path) : null;
		const after = file.kind === "deleted" ? null : await textAt(vaultPath, full, file.path);
		files.push(fileDiff(file, diff, before, after));
	}
	if (firstPath) {
		const first = files.findIndex((f) => f.path === firstPath || f.oldPath === firstPath);
		if (first > 0) files.unshift(...files.splice(first, 1));
	}
	return { hash: full, shortHash, message: message.join(FIELD).trim(), author, email, date: new Date(date), files };
}
