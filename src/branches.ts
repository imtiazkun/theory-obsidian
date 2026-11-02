import { basename } from "path";
import type { CompileReport } from "./compile";
import { PullRequest, branchPullRequest } from "./github";
import { findProjectRepos } from "./project";
import { git } from "./vault";

/** Every compile branch is named this, followed by the short hash of the latest revision compiled. */
export const COMPILE_BRANCH_PREFIX = "theory/compile-";

export interface BranchCommit {
	hash: string;
	subject: string;
}

/** What one compile did to one repository's compile branch. */
export interface CompileBranch {
	/** Absolute path of the code repository. */
	repoPath: string;
	/** The repository's name in the project folder. */
	repo: string;
	branch: string;
	/** The branch the compile branch came from, and where its pull request goes. */
	base: string;
	/** Commits this compile added, oldest first. */
	commits: BranchCommit[];
	/** False when this compile created the branch, it got no commits, and so it was deleted. */
	kept: boolean;
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

/** Names of the repositories in the project folder that have uncommitted changes. */
export async function dirtyRepos(projectFolder: string): Promise<string[]> {
	const dirty: string[] = [];
	for (const repo of projectRepos(projectFolder)) {
		const { stdout } = await git(repo.path, ["status", "--porcelain"]);
		if (stdout.trim() !== "") dirty.push(repo.name);
	}
	return dirty;
}

function isCompileBranch(branch: string | null): boolean {
	return branch?.startsWith(COMPILE_BRANCH_PREFIX) === true;
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
	try {
		await git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
		return true;
	} catch {
		return false;
	}
}

/** The base a compile recorded for this branch, newest report first. */
export function recordedBase(reports: CompileReport[], repoPath: string, branch: string): string | null {
	for (const report of reports) {
		const record = report.branches?.find((b) => b.repoPath === repoPath && b.branch === branch);
		if (record) return record.base;
	}
	return null;
}

/** The pull request opened for this branch from any report, newest first. */
export function recordedPullRequest(reports: CompileReport[], repoPath: string, branch: string): PullRequest | null {
	for (const report of reports) {
		const pr = report.pullRequests?.find((p) => p.repoPath === repoPath && p.branch === branch);
		if (pr) return pr;
	}
	return null;
}

/** True when every commit on `branch` is already in `base`. */
async function isMerged(repoPath: string, branch: string, base: string): Promise<boolean> {
	try {
		await git(repoPath, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, base]);
		return true;
	} catch {
		return false;
	}
}

/**
 * A compile branch is open until it is merged into its base or its pull request is closed.
 * The pull request's state comes from GitHub, else from the reports. Offline, only the reports are asked.
 */
export async function isOpenCompileBranch(
	repoPath: string,
	branch: string,
	base: string,
	reports: CompileReport[],
	online = true,
): Promise<boolean> {
	if (!(await branchExists(repoPath, branch))) return false;
	if (await isMerged(repoPath, branch, base)) return false;
	const pr = (online ? await branchPullRequest(repoPath, branch) : null) ?? recordedPullRequest(reports, repoPath, branch);
	return pr?.state !== "closed" && pr?.state !== "merged";
}

/** The repository's open compile branch with its base, or null. There is at most one. */
export async function openCompileBranch(
	repoPath: string,
	reports: CompileReport[],
	online = true,
): Promise<{ branch: string; base: string } | null> {
	const { stdout } = await git(repoPath, [
		"for-each-ref",
		"--sort=-committerdate",
		"--format=%(refname:short)",
		`refs/heads/${COMPILE_BRANCH_PREFIX}*`,
	]);
	const current = await currentBranch(repoPath);
	for (const branch of stdout.split("\n").map((b) => b.trim()).filter(Boolean)) {
		// A branch no report knows came from the branch the repository is on, unless that is a compile branch too.
		const base = recordedBase(reports, repoPath, branch) ?? (current && !isCompileBranch(current) ? current : "main");
		if (await isOpenCompileBranch(repoPath, branch, base, reports, online)) return { branch, base };
	}
	return null;
}

/** A compile branch checked out for a running compile. */
export interface PreparedBranch extends CodeRepo {
	branch: string;
	base: string;
	/** True when this compile created the branch. */
	created: boolean;
	/** The branch's commit before Claude ran. */
	startHead: string;
	/** The branch checked out before the compile. */
	previous: string;
}

async function headOf(repoPath: string, ref: string): Promise<string> {
	return (await git(repoPath, ["rev-parse", "--verify", ref])).stdout.trim();
}

function gitError(error: unknown): string {
	return (error as { stderr?: string }).stderr?.trim() || (error instanceof Error ? error.message : String(error));
}

/**
 * Checks out a compile branch in every repository before Claude runs: the open one when there
 * is one, else a new `theory/compile-{revision}` from the branch checked out now. Undoes what it
 * did and throws when one repository fails, so the compile doesn't start.
 */
export async function prepareBranches(projectFolder: string, head: string, reports: CompileReport[]): Promise<PreparedBranch[]> {
	const prepared: PreparedBranch[] = [];
	try {
		for (const repo of projectRepos(projectFolder)) {
			const current = await currentBranch(repo.path);
			if (!current) throw new Error(`${repo.name} isn't on a branch. Check out a branch first.`);
			const open = await openCompileBranch(repo.path, reports);
			if (open) {
				if (current !== open.branch) await git(repo.path, ["checkout", open.branch]);
				prepared.push({ ...repo, ...open, created: false, startHead: await headOf(repo.path, "HEAD"), previous: current });
				continue;
			}
			// A compile that starts on a finished compile branch goes back to that branch's base.
			const base = isCompileBranch(current) ? (recordedBase(reports, repo.path, current) ?? "main") : current;
			const branch = `${COMPILE_BRANCH_PREFIX}${head.slice(0, 7)}`;
			if (await branchExists(repo.path, branch)) {
				throw new Error(`${repo.name} already has a branch named ${branch}. Rename or delete it first.`);
			}
			await git(repo.path, ["checkout", "-b", branch, base]);
			prepared.push({ ...repo, branch, base, created: true, startHead: await headOf(repo.path, "HEAD"), previous: current });
		}
	} catch (error) {
		await undoBranches(prepared);
		throw new Error(gitError(error));
	}
	return prepared;
}

/** Puts every repository back on the branch it was on and deletes the branches this compile created. */
export async function undoBranches(prepared: PreparedBranch[]) {
	for (const p of prepared) {
		await git(p.path, ["checkout", p.previous]).catch(() => {});
		if (p.created) await git(p.path, ["branch", "-D", p.branch]).catch(() => {});
	}
}

/**
 * Runs once Claude has finished, whatever the outcome. A branch this compile created that got no
 * commits is deleted and its repository goes back to its base. A branch with commits stays checked
 * out, so the engineer can try the result.
 */
export async function finishBranches(prepared: PreparedBranch[]): Promise<CompileBranch[]> {
	const records: CompileBranch[] = [];
	for (const p of prepared) {
		// Empty when the branch is gone, e.g. Claude deleted it.
		const commits = await commitsIn(p.path, `${p.startHead}..refs/heads/${p.branch}`);
		let kept = true;
		if (p.created && commits.length === 0) {
			try {
				await git(p.path, ["checkout", p.base]);
				await git(p.path, ["branch", "-D", p.branch]);
				kept = false;
			} catch {
				// Left as it is; the engineer sees the branch in the repository.
			}
		}
		records.push({ repoPath: p.path, repo: p.name, branch: p.branch, base: p.base, commits, kept });
	}
	return records;
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

/** Commits on the compile branch that aren't in its base, oldest first. */
export function branchCommits(repoPath: string, branch: string, base: string): Promise<BranchCommit[]> {
	return commitsIn(repoPath, `${base}..refs/heads/${branch}`);
}

