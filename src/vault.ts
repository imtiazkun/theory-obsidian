import { execFile } from "child_process";
import { existsSync } from "fs";
import { mkdir, readFile, readdir, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { promisify } from "util";
import { WELCOME_PATH, WELCOME_TEXT, type StarterFile } from "./starter";
import { toolPath } from "./tool-path";

const run = promisify(execFile);

const GITIGNORE_LINES = [
	".DS_Store",
	".trash/",
	// Obsidian's settings, the plugin's build and its data with the compile reports. None of it is model.
	".obsidian/",
];

/** Obsidian's config folder isn't part of the model, even in vaults that track it from before. */
const OBSIDIAN_CONFIG = ".obsidian/";

/** Who signs the vault's commits: the name and email git uses (CFG-34). */
export interface Identity {
	name: string;
	email: string;
}

/** Shown when git isn't installed, or theory.md can't find it (CFG-35). */
export const GIT_MISSING = "theory.md needs git, and can't find it. Install git from git-scm.com, then reopen Obsidian.";
/** Shown when git has no name or no email (CMT-11, CMNT-8). */
export const IDENTITY_MISSING = "Set your name and email in git first. theory.md settings show how.";

/** A failure the engineer fixes in git, shown as it is, without a "failed:" prefix. */
export class IdentityError extends Error {}

/** What the Author section shows: git missing, or the name and email git uses, either of which may be "". */
export type GitIdentity = { kind: "no-git" } | ({ kind: "found" } & Identity);

export function isVaultSetUp(basePath: string): boolean {
	return existsSync(join(basePath, ".git"));
}

export async function git(basePath: string, args: string[], env: Record<string, string> = {}) {
	return run("git", args, {
		cwd: basePath,
		env: { ...process.env, PATH: toolPath(), ...env },
		// Diffs of a large model can exceed the 1 MB default.
		maxBuffer: 64 * 1024 * 1024,
	});
}

function isMissingCommand(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** One value from one git config file, or "" when it isn't set. Throws only when git can't run. */
async function configValue(basePath: string, scope: "--local" | "--global", key: string, command: string): Promise<string> {
	try {
		const { stdout } = await run(command, ["config", scope, "--get", key], { cwd: basePath, env: { ...process.env, PATH: toolPath() } });
		return stdout.trim();
	} catch (error) {
		if (isMissingCommand(error)) throw error;
		// Not set, or `--local` outside a repository.
		return "";
	}
}

/**
 * The name and email git signs the vault's commits with: the vault's own config, else the global one
 * (CFG-34). `command` is git's, replaceable only so tests can make git missing.
 */
export async function gitIdentity(basePath: string, command = "git"): Promise<GitIdentity> {
	try {
		const value = async (key: string) =>
			(await configValue(basePath, "--local", key, command)) || (await configValue(basePath, "--global", key, command));
		return { kind: "found", name: await value("user.name"), email: await value("user.email") };
	} catch {
		return { kind: "no-git" };
	}
}

/** What git lacks to sign a commit, in the words the Author section uses (CFG-36). */
export function missingIdentity(identity: Identity): ("name" | "email")[] {
	const missing: ("name" | "email")[] = [];
	if (!identity.name) missing.push("name");
	if (!identity.email) missing.push("email");
	return missing;
}

/** The name and email git uses. Throws an IdentityError when git is missing or lacks either. */
export async function requireIdentity(basePath: string): Promise<Identity> {
	const identity = await gitIdentity(basePath);
	if (identity.kind === "no-git") throw new IdentityError(GIT_MISSING);
	if (missingIdentity(identity).length > 0) throw new IdentityError(IDENTITY_MISSING);
	return { name: identity.name, email: identity.email };
}

/** Git `-c` arguments that sign a commit with the identity git uses, so what the settings show is what signs. */
export async function identityArgs(basePath: string): Promise<string[]> {
	const { name, email } = await requireIdentity(basePath);
	return ["-c", `user.name=${name}`, "-c", `user.email=${email}`];
}

/**
 * The name and email older versions took in settings (CFG-1 to CFG-3, retired). Never used to sign;
 * kept so the Author section can offer them for this vault (CFG-37).
 */
export interface SavedAuthor {
	fullName: string;
	email: string;
}

/** The commands that set what git lacks (CFG-36). */
export const IDENTITY_COMMANDS = {
	name: 'git config --global user.name "Your Name"',
	email: 'git config --global user.email "you@example.com"',
};

/** The author an older version saved, when git lacks a name or email and both were saved (CFG-37). */
export function savedAuthorOffer(identity: GitIdentity, saved: SavedAuthor): Identity | null {
	if (identity.kind !== "found" || missingIdentity(identity).length === 0) return null;
	const name = saved.fullName.trim();
	const email = saved.email.trim();
	return name && email ? { name, email } : null;
}

/**
 * Writes a name and email saved by an older version into the vault's own git config, never the global
 * one (CFG-37).
 */
export async function useSavedAuthor(basePath: string, author: Identity): Promise<void> {
	if (!isVaultSetUp(basePath)) throw new Error("Set up the vault first.");
	await git(basePath, ["config", "--local", "user.name", author.name]);
	await git(basePath, ["config", "--local", "user.email", author.email]);
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

/**
 * Turns Obsidian's `Welcome.md` at the vault root into theory.md's welcome note, `_welcome.md` (SET-16).
 * Writes nothing when there is no `Welcome.md`, or when `_welcome.md` already exists (SET-17).
 * Returns whether it wrote the welcome note.
 */
export async function writeWelcome(basePath: string): Promise<boolean> {
	if ((await findIgnoringCase(basePath, WELCOME_PATH)) !== null) return false;
	const welcome = await findIgnoringCase(basePath, "Welcome.md");
	if (welcome === null) return false;
	await writeFile(join(basePath, welcome), WELCOME_TEXT);
	await rename(join(basePath, welcome), join(basePath, WELCOME_PATH));
	return true;
}

/**
 * Turns the vault into a git repository whose initial commit includes the starter files and the
 * welcome note. Returns whether it wrote the welcome note.
 */
export async function setUpVault(basePath: string, starterFiles: StarterFile[]): Promise<boolean> {
	if (isVaultSetUp(basePath)) return false;

	// Check before `git init`, otherwise a failed commit leaves a half set-up repository (SET-3).
	const identity = await identityArgs(basePath);

	await addStarterFiles(basePath, starterFiles);
	const welcomed = await writeWelcome(basePath);
	await git(basePath, ["init", "-b", "main"]);
	await ensureGitignore(basePath);
	await git(basePath, ["add", "-A"]);
	await git(basePath, [...identity, "commit", "--allow-empty", "-m", "Initial commit"]);
	return welcomed;
}

/**
 * Writes the starter files and `.gitignore` lines a set-up vault is missing, and commits only those
 * files as "Add missing starter files". Returns the number of files written or changed.
 */
export async function addMissingStarterFiles(basePath: string, starterFiles: StarterFile[]): Promise<number> {
	// Checked before anything is written, so a missing author never leaves files behind.
	await identityArgs(basePath);
	const paths = await addStarterFiles(basePath, starterFiles);
	if (await ensureGitignore(basePath)) paths.push(".gitignore");
	if (paths.length === 0) return 0;
	await commit(basePath, "Add missing starter files", paths);
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
export async function commit(basePath: string, message: string, paths: string[] | "all"): Promise<string> {
	const identity = await identityArgs(basePath);
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
