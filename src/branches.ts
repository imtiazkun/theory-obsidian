import { basename } from "path";
import { findProjectRepos } from "./project";
import { NO_PROMPT_ENV } from "./pull";
import { git } from "./vault";

/**
 * Every branch a build makes starts with this: issue branches `theory/{number}-{short name}` and epic branches
 * `theory/epic-{number}-{short name}` (BLD-10, BLD-11). Together they are the compile branches (see Concepts).
 */
export const COMPILE_BRANCH_PREFIX = "theory/";

export interface BranchCommit {
	hash: string;
	subject: string;
}

export interface CodeRepo {
	path: string;
	name: string;
}

/** The git repositories in the project folder: the folder itself, or its direct subfolders. */
export function projectRepos(projectFolder: string): CodeRepo[] {
	const found = findProjectRepos(projectFolder);
	if (found.kind !== "root" && found.kind !== "children") return [];
	return found.repos.map((path) => ({ path, name: basename(path) }));
}

/** The checked-out branch, or null when HEAD is detached or the repository has no commits. */
export async function currentBranch(repoPath: string): Promise<string | null> {
	try {
		const { stdout } = await git(repoPath, ["symbolic-ref", "--short", "-q", "HEAD"]);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

/** How many files git sees as changed, new or deleted in the working tree. */
export async function uncommittedCount(repoPath: string): Promise<number> {
	const { stdout } = await git(repoPath, ["status", "--porcelain", "--untracked-files=all"]);
	return stdout.split("\n").filter((line) => line.trim() !== "").length;
}

/** Names of the repositories that have uncommitted changes, from the project folder or the given list. */
export async function dirtyRepos(projectFolder: string, repos: CodeRepo[] = projectRepos(projectFolder)): Promise<string[]> {
	const dirty: string[] = [];
	for (const repo of repos) {
		const { stdout } = await git(repo.path, ["status", "--porcelain"]);
		if (stdout.trim() !== "") dirty.push(repo.name);
	}
	return dirty;
}

/** The issue branch's name before BLD-12 adds a number: `theory/{number}-{short name}` (BLD-10). */
export function issueBranchName(issue: { number?: number; shortName: string }): string {
	return `theory/${issue.number}-${issue.shortName}`;
}

/** The epic branch's name before BLD-12 adds a number: `theory/epic-{number}-{short name}` (BLD-11). */
export function epicBranchName(epic: { number?: number; shortName: string }): string {
	return `theory/epic-${epic.number}-${epic.shortName}`;
}

export function isCompileBranch(branch: string | null): boolean {
	return branch?.startsWith(COMPILE_BRANCH_PREFIX) === true;
}

export async function refExists(repoPath: string, ref: string): Promise<boolean> {
	try {
		await git(repoPath, ["rev-parse", "--verify", "--quiet", ref]);
		return true;
	} catch {
		return false;
	}
}

export function branchExists(repoPath: string, branch: string): Promise<boolean> {
	return refExists(repoPath, `refs/heads/${branch}`);
}

/** True when the branch exists here or on `origin`, as git last fetched it. */
async function nameTaken(repoPath: string, branch: string): Promise<boolean> {
	return (await branchExists(repoPath, branch)) || (await refExists(repoPath, `refs/remotes/origin/${branch}`));
}

/**
 * `name`, or `name-2`, `name-3` and so on: the first that no repository in `repoPaths` has, here or on `origin`.
 * A branch is never reused or overwritten (BLD-12), and an epic branch gets one name in every repository (BLD-11).
 */
export async function uniqueBranchName(repoPaths: string[], name: string): Promise<string> {
	for (let n = 1; ; n++) {
		const candidate = n === 1 ? name : `${name}-${n}`;
		let taken = false;
		for (const repoPath of repoPaths) if (await nameTaken(repoPath, candidate)) taken = true;
		if (!taken) return candidate;
	}
}

/** The branch's upstream, like `origin/main`, or null when it has none or it was never fetched. */
export async function upstreamOf(repoPath: string, branch: string): Promise<string | null> {
	const { stdout } = await git(repoPath, ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`]);
	const upstream = stdout.trim();
	return upstream && (await refExists(repoPath, upstream)) ? upstream : null;
}

/**
 * The repository's default branch: the one `origin/HEAD` points at, else `main`, else `master`, else the branch
 * checked out. Null when there is none, e.g. a repository without commits.
 */
export async function defaultBranch(repoPath: string): Promise<string | null> {
	try {
		const { stdout } = await git(repoPath, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
		const name = stdout.trim().replace(/^origin\//, "");
		if (name && (await branchExists(repoPath, name))) return name;
	} catch {
		// origin/HEAD isn't set, e.g. a remote added by hand.
	}
	for (const name of ["main", "master"]) if (await branchExists(repoPath, name)) return name;
	return currentBranch(repoPath);
}

export async function headOf(repoPath: string, ref: string): Promise<string> {
	return (await git(repoPath, ["rev-parse", "--verify", ref])).stdout.trim();
}

export function gitError(error: unknown): string {
	return (error as { stderr?: string }).stderr?.trim() || (error instanceof Error ? error.message : String(error));
}

async function countRange(repoPath: string, range: string): Promise<number> {
	return Number((await git(repoPath, ["rev-list", "--count", range])).stdout.trim());
}

/** Thrown when a branch and its upstream both have new commits, so only a person can bring them together. */
export class DivergedError extends Error {}

/**
 * Brings a local branch up to `upstream`, as git last fetched it. A branch that is only behind is fast-forwarded,
 * checked out or not. Throws DivergedError when it has commits of its own too. Never merges or rebases.
 */
export async function fastForwardTo(repoPath: string, branch: string, upstream: string | null) {
	if (!upstream || !(await refExists(repoPath, upstream))) return;
	const local = `refs/heads/${branch}`;
	if ((await countRange(repoPath, `${local}..${upstream}`)) === 0) return;
	if ((await countRange(repoPath, `${upstream}..${local}`)) > 0) throw new DivergedError(`${branch} and ${upstream} both have new commits.`);
	if ((await currentBranch(repoPath)) === branch) {
		// Git refuses rather than overwrite anything in the working tree.
		await git(repoPath, ["merge", "--ff-only", "--quiet", upstream]);
	} else {
		// Not checked out, so only its ref moves, and only from where it was.
		await git(repoPath, ["update-ref", local, await headOf(repoPath, upstream), await headOf(repoPath, local)]);
	}
}

/** True when every commit on `branch` is already in `base`, or in its upstream as git last fetched it. */
export async function isMerged(repoPath: string, branch: string, base: string): Promise<boolean> {
	const ref = (await branchExists(repoPath, branch)) ? `refs/heads/${branch}` : `refs/remotes/origin/${branch}`;
	for (const target of [`refs/heads/${base}`, await upstreamOf(repoPath, base).catch(() => null), `refs/remotes/origin/${base}`]) {
		if (!target || !(await refExists(repoPath, target))) continue;
		try {
			await git(repoPath, ["merge-base", "--is-ancestor", ref, target]);
			return true;
		} catch {
			// Not merged into this one.
		}
	}
	return false;
}

/** Pushes the branch to `origin` and sets it as its upstream. Never forced (BLD-25). */
export async function pushBranch(repoPath: string, branch: string) {
	try {
		await git(repoPath, ["push", "--quiet", "-u", "origin", `refs/heads/${branch}:refs/heads/${branch}`], NO_PROMPT_ENV);
	} catch (error) {
		throw new Error(gitError(error));
	}
}

/** Commits in a `git log` range, oldest first, or none when the range can't be read. */
async function commitsIn(repoPath: string, range: string): Promise<BranchCommit[]> {
	try {
		const { stdout } = await git(repoPath, ["log", "--reverse", "--format=%H%x1f%s", range]);
		return stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [hash, subject] = line.split("\x1f");
				return { hash, subject };
			});
	} catch {
		return [];
	}
}

/** Commits on the branch that aren't in its base, oldest first. */
export function branchCommits(repoPath: string, branch: string, base: string): Promise<BranchCommit[]> {
	return commitsIn(repoPath, `${base}..refs/heads/${branch}`);
}
