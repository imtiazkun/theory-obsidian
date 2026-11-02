import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { TFile, TFolder } from "obsidian";
import { CodeRepo, currentBranch, openCompileBranch, recordedPullRequest, uncommittedCount } from "./branches";
import { COMPILED_TAG, type CompileReport } from "./compile";
import { PullRequestState, gh, ghProblem, githubOrigin, hasOrigin } from "./github";
import type TheoryPlugin from "./main";
import { REALIZED_KEY } from "./note-status";
import { commit, git, identityArgs } from "./vault";

/** The first line of every model folder's instructions.md. */
export const MODEL_INSTRUCTIONS =
	"The writing rules in [the root Instructions](../Instructions.md) apply here. Rules for Claude that apply only to this repository go below.\n";

/** The repository's model folder: the folder at the vault root with exactly its name. */
export function modelFolder(plugin: TheoryPlugin, name: string): TFolder | null {
	const folder = plugin.app.vault.getRoot().children.find((child) => child instanceof TFolder && child.name === name);
	return folder instanceof TFolder ? folder : null;
}

/** The model folder's index.md, matched ignoring case. */
export function modelIndex(folder: TFolder): TFile | null {
	const index = folder.children.find((child) => child instanceof TFile && child.name.toLowerCase() === "index.md");
	return index instanceof TFile ? index : null;
}

/** Everything a repository's card shows. Worked out from git, gh and the reports each time, never stored. */
export interface RepoKpis extends CodeRepo {
	code: { branch: string | null; lastCommit: { date: Date; author: string } | null; uncommitted: number };
	compile: {
		/** The newest compile that changed this repository. */
		last: CompileReport | null;
		openBranch: { branch: string; pr: PullRequestState | null } | null;
	};
	/** Null when the repository has no model folder. */
	model: { notes: number; unrealized: number; waiting: number } | null;
	/** Null when the repository has no `origin`. */
	remote: { url: string | null; ahead: number; behind: number } | { url: string | null; ahead: null; behind: null } | null;
}

async function lastCommit(repoPath: string): Promise<{ date: Date; author: string } | null> {
	try {
		const { stdout } = await git(repoPath, ["log", "-1", "--format=%aI%x1f%an"]);
		const [date, author] = stdout.trim().split("\x1f");
		return date ? { date: new Date(date), author } : null;
	} catch {
		return null;
	}
}

/** Commits the current branch is ahead of and behind the same branch on `origin`, as git last saw it. */
async function aheadBehind(repoPath: string, branch: string | null): Promise<{ ahead: number; behind: number } | null> {
	if (!branch) return null;
	try {
		const { stdout } = await git(repoPath, ["rev-list", "--left-right", "--count", `HEAD...refs/remotes/origin/${branch}`]);
		const [ahead, behind] = stdout.trim().split(/\s+/).map(Number);
		return { ahead, behind };
	} catch {
		return null;
	}
}

/** Vault paths changed since the last compile, or "all" when nothing has been compiled. */
async function pendingPaths(vaultPath: string): Promise<{ tracked: Set<string>; pending: Set<string> | "all" }> {
	const { stdout: files } = await git(vaultPath, ["ls-files", "-z"]);
	const tracked = new Set(files.split("\0").filter(Boolean));
	try {
		const { stdout } = await git(vaultPath, ["diff", "--name-only", "-z", `refs/tags/${COMPILED_TAG}`, "HEAD"]);
		return { tracked, pending: new Set(stdout.split("\0").filter(Boolean)) };
	} catch {
		return { tracked, pending: "all" };
	}
}

/** Works out every card's numbers. Never fetches, and asks GitHub nothing, so it is fast and works offline. */
export async function repoKpis(plugin: TheoryPlugin, repos: CodeRepo[]): Promise<RepoKpis[]> {
	const { reports } = plugin;
	const vaultState = plugin.isVaultSetUp() ? await pendingPaths(plugin.getVaultPath()).catch(() => null) : null;
	const result: RepoKpis[] = [];
	for (const repo of repos) {
		const branch = await currentBranch(repo.path);
		const uncommitted = await uncommittedCount(repo.path).catch(() => 0);

		const last = reports.find((r) => r.branches?.some((b) => b.repoPath === repo.path && b.commits.length > 0)) ?? null;
		const open = await openCompileBranch(repo.path, reports, false).catch(() => null);
		const openBranch = open
			? { branch: open.branch, pr: recordedPullRequest(reports, repo.path, open.branch)?.state ?? null }
			: null;

		const folder = modelFolder(plugin, repo.name);
		let model: RepoKpis["model"] = null;
		if (folder) {
			const notes = plugin.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${folder.path}/`));
			const unrealized = notes.filter(
				(file) => plugin.app.metadataCache.getFileCache(file)?.frontmatter?.[REALIZED_KEY] === false,
			).length;
			const waiting = vaultState
				? notes.filter((file) => vaultState.tracked.has(file.path) && (vaultState.pending === "all" || vaultState.pending.has(file.path))).length
				: 0;
			model = { notes: notes.length, unrealized, waiting };
		}

		let remote: RepoKpis["remote"] = null;
		if (await hasOrigin(repo.path)) {
			const url = await githubOrigin(repo.path);
			remote = { url, ...((await aheadBehind(repo.path, branch)) ?? { ahead: null, behind: null }) };
		}

		result.push({
			...repo,
			code: { branch, lastCommit: await lastCommit(repo.path), uncommitted },
			compile: { last, openBranch },
			model,
			remote,
		});
	}
	return result;
}

/** Runs `git fetch` in every repository. Returns the names of the ones that couldn't fetch. */
export async function fetchAll(repos: CodeRepo[]): Promise<string[]> {
	const failed: string[] = [];
	for (const repo of repos) {
		if (!(await hasOrigin(repo.path))) continue;
		await git(repo.path, ["fetch", "--quiet"]).catch(() => failed.push(repo.name));
	}
	return failed;
}

/** Writes a model file through Obsidian, so the file explorer shows it at once. */
async function writeVaultFile(plugin: TheoryPlugin, path: string, content: string) {
	const { vault } = plugin.app;
	const folder = path.slice(0, path.lastIndexOf("/"));
	if (folder && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
	await vault.create(path, content);
}

/** Creates a model folder with index.md and instructions.md, and commits only those two files. */
export async function addModelFolder(plugin: TheoryPlugin, name: string, index: string, message: string): Promise<string> {
	const vaultPath = plugin.getVaultPath();
	// Checked before anything is written, so a missing author never leaves files behind.
	await identityArgs(vaultPath, plugin.settings);
	const paths = [`${name}/index.md`, `${name}/instructions.md`];
	await writeVaultFile(plugin, paths[0], index);
	await writeVaultFile(plugin, paths[1], MODEL_INSTRUCTIONS);
	return commit(vaultPath, plugin.settings, message, paths);
}

export type Visibility = "private" | "public";

export interface NewRepository {
	name: string;
	description: string;
	purpose: string;
	stack: string;
	build: string;
	test: string;
	run: string;
	conventions: string;
	github: boolean;
	visibility: Visibility;
}

export const REPO_NAME = /^[a-z0-9-]+$/;

/** The reason the name can't be used, or null. */
export function nameProblem(plugin: TheoryPlugin, name: string): string | null {
	if (!REPO_NAME.test(name)) return "Use lowercase letters, digits and dashes.";
	if (existsSync(join(plugin.settings.projectFolder, name)) || plugin.app.vault.getAbstractFileByPath(name)) {
		return `${name} already exists.`;
	}
	return null;
}

/** True when the field was filled in. */
function given(value: string): boolean {
	return value.trim() !== "";
}

/** Lines for empty fields are left out. The text is used exactly as typed; no AI writes any of it. */
function lines(...parts: (string | false)[]): string {
	return parts.filter((part): part is string => typeof part === "string").join("\n\n") + "\n";
}

export function readmeText(r: NewRepository): string {
	const commands = [
		given(r.build) && `- Build: \`${r.build}\``,
		given(r.run) && `- Run: \`${r.run}\``,
		given(r.test) && `- Test: \`${r.test}\``,
	].filter((line): line is string => typeof line === "string");
	return lines(
		`# ${r.name}`,
		r.description,
		given(r.purpose) && r.purpose,
		given(r.stack) && `Stack: ${r.stack}`,
		commands.length > 0 && `## Getting started\n\n${commands.join("\n")}`,
	);
}

export function agentsText(r: NewRepository, vaultName: string): string {
	const commands = [
		given(r.build) && `- Build: \`${r.build}\``,
		given(r.test) && `- Test: \`${r.test}\``,
		given(r.run) && `- Run: \`${r.run}\``,
	].filter((line): line is string => typeof line === "string");
	return lines(
		"# AGENTS.md",
		`The theoretical model in the ${vaultName} vault, folder ${r.name}/, is the source of truth for this repository.`,
		given(r.stack) && `Stack: ${r.stack}`,
		commands.length > 0 && `## Commands\n\n${commands.join("\n")}`,
		given(r.conventions) && `## Conventions\n\n${r.conventions}`,
	);
}

export function modelIndexText(r: NewRepository): string {
	return lines("## What this repository is", r.description, given(r.purpose) && r.purpose);
}

/**
 * Creates a repository in the project folder and its model folder in the vault, step by step.
 * When a step fails it stops there and throws, with the steps already done. It never deletes what it created.
 */
export async function createRepository(plugin: TheoryPlugin, r: NewRepository, done: (step: string) => void): Promise<void> {
	const vaultPath = plugin.getVaultPath();
	const repoPath = join(plugin.settings.projectFolder, r.name);

	const problem = nameProblem(plugin, r.name);
	if (problem) throw new Error(problem);
	const identity = await identityArgs(vaultPath, plugin.settings);
	if (r.github) {
		const blocked = await ghProblem(plugin.settings.projectFolder);
		if (blocked) throw new Error(blocked);
	}
	done("Checked the name, the author and GitHub.");

	await mkdir(repoPath);
	await git(repoPath, ["init", "-b", "main"]);
	await writeFile(join(repoPath, "README.md"), readmeText(r));
	await writeFile(join(repoPath, "AGENTS.md"), agentsText(r, plugin.app.vault.getName()));
	await git(repoPath, ["add", "--", "README.md", "AGENTS.md"]);
	await git(repoPath, [...identity, "commit", "-m", "Initial commit"]);
	done(`Created ${r.name} in the project folder with an initial commit.`);

	await addModelFolder(plugin, r.name, modelIndexText(r), `Add repository ${r.name}`);
	done(`Added the model folder ${r.name}/ to the vault and committed it.`);

	if (r.github) {
		await gh(repoPath, ["repo", "create", r.name, `--${r.visibility}`, "--source", ".", "--remote", "origin", "--push"]);
		done(`Created the ${r.visibility} GitHub repository and pushed main.`);
	}
}
