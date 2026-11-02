import { execFile } from "child_process";
import { existsSync } from "fs";
import { readFile, readdir, writeFile } from "fs/promises";
import { join } from "path";
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

async function ensureGitignore(basePath: string) {
	const path = join(basePath, ".gitignore");
	const existing = existsSync(path) ? await readFile(path, "utf8") : "";
	const present = new Set(existing.split("\n").map((line) => line.trim()));
	const missing = GITIGNORE_LINES.filter((line) => !present.has(line));
	if (missing.length === 0) return;
	const prefix = existing === "" || existing.endsWith("\n") ? existing : existing + "\n";
	await writeFile(path, prefix + missing.join("\n") + "\n");
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

/** Writes each starter file unless the vault root already has it, under any of its names. */
async function addStarterFiles(basePath: string, files: StarterFile[]) {
	const existing = new Set((await readdir(basePath)).map((name) => name.toLowerCase()));
	for (const file of files) {
		if (file.sameAs.some((name) => existing.has(name.toLowerCase()))) continue;
		await writeFile(join(basePath, file.path), file.content);
	}
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

/** Paths (relative to the vault) with changes not yet committed, including new files. */
export async function changedFiles(basePath: string): Promise<string[]> {
	const { stdout } = await git(basePath, ["status", "--porcelain", "-z", "--untracked-files=all"]);
	const entries = stdout.split("\0").filter((entry) => entry !== "");
	const paths: string[] = [];
	for (let i = 0; i < entries.length; i++) {
		const status = entries[i].slice(0, 2);
		paths.push(entries[i].slice(3));
		// Renames are followed by their original path, which isn't a separate change.
		if (status.includes("R") || status.includes("C")) i++;
	}
	return paths.filter((path) => !path.startsWith(OBSIDIAN_CONFIG));
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
		await git(basePath, ["add", "-A", "--", ...(await changedFiles(basePath))]);
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
