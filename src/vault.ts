import { execFile } from "child_process";
import { existsSync } from "fs";
import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { promisify } from "util";
import type { StarterFile } from "./starter";

const run = promisify(execFile);

// Apps launched from the Dock get a minimal PATH, so add the usual tool locations.
export const TOOL_PATH = [
	process.env.PATH,
	"/usr/bin",
	"/usr/local/bin",
	"/opt/homebrew/bin",
	process.env.HOME && `${process.env.HOME}/.local/bin`,
]
	.filter(Boolean)
	.join(":");

const GITIGNORE_LINES = [
	".DS_Store",
	".trash/",
	// Obsidian's settings, the plugin's build and its data with the compile reports. None of it is model.
	".obsidian/",
];

/** Obsidian's config folder isn't part of the model, even in vaults that track it from before. */
const OBSIDIAN_CONFIG = ".obsidian/";

export interface Author {
	fullName: string;
	email: string;
}

export function isVaultSetUp(basePath: string): boolean {
	return existsSync(join(basePath, ".git"));
}

export async function git(basePath: string, args: string[]) {
	return run("git", args, {
		cwd: basePath,
		env: { ...process.env, PATH: TOOL_PATH },
		// Diffs of a large model can exceed the 1 MB default.
		maxBuffer: 64 * 1024 * 1024,
	});
}

async function hasGitConfig(basePath: string, key: string): Promise<boolean> {
	try {
		const { stdout } = await git(basePath, ["config", "--get", key]);
		return stdout.trim() !== "";
	} catch {
		return false;
	}
}

async function readGitignore(basePath: string): Promise<string> {
	const path = join(basePath, ".gitignore");
	return existsSync(path) ? readFile(path, "utf8") : "";
}

function missingLines(gitignore: string): string[] {
	const present = new Set(gitignore.split("\n").map((line) => line.trim()));
	return GITIGNORE_LINES.filter((line) => !present.has(line));
}

/** Adds the missing lines to `.gitignore` and keeps every other line. Returns true when it changed the file. */
async function ensureGitignore(basePath: string): Promise<boolean> {
	const existing = await readGitignore(basePath);
	const missing = missingLines(existing);
	if (missing.length === 0) return false;
	const prefix = existing === "" || existing.endsWith("\n") ? existing : existing + "\n";
	await writeFile(join(basePath, ".gitignore"), prefix + missing.join("\n") + "\n");
	return true;
}

/**
 * Git `-c` arguments that sign commits as the author from theory.md settings,
 * falling back to git's own config. Throws when neither has a name or email.
 */
export async function identityArgs(basePath: string, author: Author): Promise<string[]> {
	if (!author.fullName && !(await hasGitConfig(basePath, "user.name"))) {
		throw new Error("Set your full name in theory.md settings first.");
	}
	if (!author.email && !(await hasGitConfig(basePath, "user.email"))) {
		throw new Error("Set your email address in theory.md settings first.");
	}
	const args: string[] = [];
	if (author.fullName) args.push("-c", `user.name=${author.fullName}`);
	if (author.email) args.push("-c", `user.email=${author.email}`);
	return args;
}

/** The author's name from theory.md settings, else from the git config, else "". */
export async function authorName(basePath: string, author: Author): Promise<string> {
	if (author.fullName) return author.fullName;
	try {
		const { stdout } = await git(basePath, ["config", "--get", "user.name"]);
		return stdout.trim();
	} catch {
		return "";
	}
}

/** The path (relative to `basePath`) of the file or folder at `path`, matched ignoring case, or null. */
export async function findIgnoringCase(basePath: string, path: string): Promise<string | null> {
	let found = "";
	for (const part of path.split("/")) {
		const entries = await readdir(join(basePath, found)).catch(() => [] as string[]);
		const match = entries.find((entry) => entry === part) ?? entries.find((entry) => entry.toLowerCase() === part.toLowerCase());
		if (match === undefined) return null;
		found = found ? `${found}/${match}` : match;
	}
	return found;
}

/** Where a missing starter file goes: its own path, inside a folder that already exists under another case. */
async function starterPath(basePath: string, path: string): Promise<string> {
	const slash = path.lastIndexOf("/");
	if (slash === -1) return path;
	const folder = (await findIgnoringCase(basePath, path.slice(0, slash))) ?? path.slice(0, slash);
	return `${folder}/${path.slice(slash + 1)}`;
}

export interface MissingStarters {
	files: StarterFile[];
	gitignoreLines: string[];
}

/** The starter files the vault doesn't have under any of their names, and the missing `.gitignore` lines. */
export async function missingStarters(basePath: string, files: StarterFile[]): Promise<MissingStarters> {
	const missing: StarterFile[] = [];
	for (const file of files) {
		const found = await Promise.all(file.sameAs.map((name) => findIgnoringCase(basePath, name)));
		if (found.every((path) => path === null)) missing.push(file);
	}
	return { files: missing, gitignoreLines: missingLines(await readGitignore(basePath)) };
}

/** Writes each starter file the vault doesn't have yet. Never changes a file that exists. Returns the paths written. */
async function addStarterFiles(basePath: string, files: StarterFile[]): Promise<string[]> {
	const written: string[] = [];
	for (const file of (await missingStarters(basePath, files)).files) {
		const path = await starterPath(basePath, file.path);
		await mkdir(dirname(join(basePath, path)), { recursive: true });
		// "wx" fails rather than overwrite a file that appeared in the meantime.
		await writeFile(join(basePath, path), file.content, { flag: "wx" });
		written.push(path);
	}
	return written;
}

/** Turns the vault into a git repository whose initial commit includes the starter files. */
export async function setUpVault(basePath: string, author: Author, starterFiles: StarterFile[]): Promise<void> {
	if (isVaultSetUp(basePath)) return;

	// Check before `git init`, otherwise a failed commit leaves a half set-up repository.
	const identity = await identityArgs(basePath, author);

	await addStarterFiles(basePath, starterFiles);
	await git(basePath, ["init", "-b", "main"]);
	await ensureGitignore(basePath);
	await git(basePath, ["add", "-A"]);
	await git(basePath, [...identity, "commit", "--allow-empty", "-m", "Initial commit"]);
}

/**
 * Writes the starter files and `.gitignore` lines a set-up vault is missing, and commits only those
 * files as "Add missing starter files". Returns the number of files written or changed.
 */
export async function addMissingStarterFiles(basePath: string, author: Author, starterFiles: StarterFile[]): Promise<number> {
	// Checked before anything is written, so a missing author never leaves files behind.
	await identityArgs(basePath, author);
	const paths = await addStarterFiles(basePath, starterFiles);
	if (await ensureGitignore(basePath)) paths.push(".gitignore");
	if (paths.length === 0) return 0;
	await commit(basePath, author, "Add missing starter files", paths);
	return paths.length;
}

interface Change {
	path: string;
	/** Git's two-letter porcelain status, e.g. " M", "??" or "D ". */
	status: string;
}

/** Uncommitted changes outside Obsidian's config folder, including new files. */
async function changes(basePath: string): Promise<Change[]> {
	const { stdout } = await git(basePath, ["status", "--porcelain", "-z", "--untracked-files=all"]);
	const entries = stdout.split("\0").filter((entry) => entry !== "");
	const found: Change[] = [];
	for (let i = 0; i < entries.length; i++) {
		const status = entries[i].slice(0, 2);
		found.push({ path: entries[i].slice(3), status });
		// Renames are followed by their original path, which isn't a separate change.
		if (status.includes("R") || status.includes("C")) i++;
	}
	return found.filter((change) => !change.path.startsWith(OBSIDIAN_CONFIG));
}

/** Paths (relative to the vault) with changes not yet committed, including new files. */
export async function changedFiles(basePath: string): Promise<string[]> {
	return (await changes(basePath)).map((change) => change.path);
}

/**
 * Commits `paths` (relative to the vault), or every change when `paths` is "all".
 * Returns the new commit's short hash.
 */
export async function commit(
	basePath: string,
	author: Author,
	message: string,
	paths: string[] | "all",
): Promise<string> {
	const identity = await identityArgs(basePath, author);
	if (paths === "all") {
		// Stage the changed files by name. Excluding `.obsidian/` with a pathspec fails once
		// .gitignore lists it, because git then refuses the ignored path outright.
		// A deletion that is already staged has nothing left to add, and git refuses its path.
		const paths = (await changes(basePath)).filter((change) => change.status !== "D ").map((change) => change.path);
		if (paths.length > 0) await git(basePath, ["add", "-A", "--", ...paths]);
		await git(basePath, [...identity, "commit", "-m", message]);
	} else {
		await git(basePath, ["add", "-A", "--", ...paths]);
		// Naming the paths commits only them, even if other files are staged.
		await git(basePath, [...identity, "commit", "-m", message, "--", ...paths]);
	}
	const { stdout } = await git(basePath, ["rev-parse", "--short", "HEAD"]);
	return stdout.trim();
}

export interface Commit {
	hash: string;
	author: string;
	email: string;
	date: Date;
	subject: string;
}

// Unit separator, so subjects containing tabs or pipes can't break parsing.
const FIELD = "\x1f";

/** Commits that touched `filePath` (relative to the vault), newest first. */
export async function fileHistory(basePath: string, filePath: string): Promise<Commit[]> {
	const format = ["%H", "%an", "%ae", "%aI", "%s"].join(FIELD);
	let stdout: string;
	try {
		({ stdout } = await git(basePath, [
			"log",
			"--follow",
			`--format=${format}`,
			"--",
			filePath,
		]));
	} catch (error) {
		// A repository with no commits yet has no history to show.
		if (String(error).includes("does not have any commits")) return [];
		throw error;
	}
	return stdout
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => {
			const [hash, author, email, date, subject] = line.split(FIELD);
			return { hash, author, email, date: new Date(date), subject };
		});
}

/**
 * The uncommitted changes to `paths` as a diff, limited to `pathspecs`. Tracked files are diffed
 * against HEAD; new files are shown whole.
 */
export async function uncommittedDiff(basePath: string, paths: string[], pathspecs: string[]): Promise<string> {
	if (paths.length === 0) return "";
	const { stdout: listed } = await git(basePath, ["ls-files", "-z", "--", ...paths, ...pathspecs]);
	const tracked = listed.split("\0").filter(Boolean);
	const { stdout: others } = await git(basePath, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...paths, ...pathspecs]);
	const untracked = others.split("\0").filter(Boolean);

	const parts: string[] = [];
	if (tracked.length > 0) {
		const { stdout } = await git(basePath, ["diff", "--stat", "--patch", "HEAD", "--", ...tracked]);
		parts.push(stdout);
	}
	for (const path of untracked) {
		const content = await readFile(join(basePath, path), "utf8").catch(() => "");
		parts.push(`New file: ${path}\n${content}`);
	}
	return parts.join("\n");
}

/** True when the file differs from its last committed version or isn't tracked yet. */
export async function hasUncommittedChanges(basePath: string, filePath: string): Promise<boolean> {
	const { stdout } = await git(basePath, ["status", "--porcelain", "--", filePath]);
	return stdout.trim() !== "";
}
