import { spawn } from "child_process";
import { createHash } from "crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { CodeRepo, branchExists, defaultBranch, gitError, refExists } from "./branches";
import type { GitHub } from "./github";
import { toolPath } from "./tool-path";
import { git } from "./vault";

/**
 * Where a repository's code in the code snapshot came from (CMP-84, CMP-87): `origin/{default branch}` just fetched,
 * `origin/{default branch}` as the last fetch left it, or the local default branch of a repository never fetched.
 */
export type CodeSource = "origin" | "last-fetch" | "local";

/** The code one repository was read at in a compile (REP-43). Stored on the report, so the shared report can carry it. */
export interface CodeRead {
	repo: string;
	branch: string;
	/** The full commit hash. */
	commit: string;
	source: CodeSource;
	/** The commit on GitHub, when the repository's GitHub name is known. */
	url?: string;
}

/** The code snapshot of one compile: the folder, and what each repository in it was read at. */
export interface CodeSnapshot {
	dir: string;
	code: CodeRead[];
}

/** Runs a tool with the login PATH, and throws with its error output when it fails. */
export function runTool(command: string, args: string[]): Promise<void> {
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

/** A hash of every path and file in `dir`, to check nothing in a snapshot changed (INV-5, INV-14). */
export async function hashTree(dir: string): Promise<string> {
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

/** Deletes a read-only snapshot folder, the model's or the code's. */
export async function removeSnapshot(dir: string) {
	await runTool("chmod", ["-R", "u+w", dir]).catch(() => {});
	await rm(dir, { recursive: true, force: true });
}

/** Thrown when a repository's default branch can't be read into the code snapshot (CMP-88). */
export class CodeReadError extends Error {
	constructor(branch: string, repo: string, reason: string) {
		super(`Couldn't read ${branch} of ${repo}: ${reason.replace(/\.$/, "")}`);
	}
}

/** The branch `origin/HEAD` points at, as git last fetched it, or null. */
async function originHead(repoPath: string): Promise<string | null> {
	try {
		const { stdout } = await git(repoPath, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
		return stdout.trim().replace(/^origin\//, "") || null;
	} catch {
		return null;
	}
}

/**
 * The repository's default branch as GitHub names it (CMP-84). When GitHub can't be asked, e.g. offline (CMP-87),
 * the one `origin/HEAD` pointed at in the last fetch, else the local default branch.
 */
async function defaultBranchOf(github: GitHub, repoPath: string): Promise<string | null> {
	const named = await github.defaultBranch(repoPath).catch(() => null);
	if (named) return named;
	return (await originHead(repoPath)) ?? (await defaultBranch(repoPath));
}

/** The ref to copy the default branch from, and where it came from (CMP-84, CMP-87). */
async function sourceRef(repoPath: string, branch: string, fetched: boolean): Promise<{ ref: string; source: CodeSource } | null> {
	if (await refExists(repoPath, `refs/remotes/origin/${branch}`)) {
		return { ref: `refs/remotes/origin/${branch}`, source: fetched ? "origin" : "last-fetch" };
	}
	// A repository that was never fetched has no origin/{branch}: its own branch is all there is.
	if (await branchExists(repoPath, branch)) return { ref: `refs/heads/${branch}`, source: "local" };
	return null;
}

/**
 * Copies each repository's default branch, as `origin` has it, into a new read-only folder outside the project
 * folder, one folder per repository under its own name (CMP-84). Only `git archive` reads the repository, so no
 * checkout, branch, ref, stash or config ever changes (CMP-85), and nothing unpushed or uncommitted is copied
 * (CMP-86). `fetched` holds the paths of the repositories the pull before the compile fetched; the others are read
 * as of their last fetch (CMP-87). Throws CodeReadError, with nothing left behind, when a branch can't be read
 * (CMP-88).
 */
export async function createCodeSnapshot(repos: CodeRepo[], github: GitHub, fetched: ReadonlySet<string>): Promise<CodeSnapshot> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "theory-code-")));
	const code: CodeRead[] = [];
	try {
		for (const repo of repos) {
			const branch = await defaultBranchOf(github, repo.path);
			if (!branch) throw new CodeReadError("the default branch", repo.name, "It has no branch yet. Commit to it first.");
			const from = await sourceRef(repo.path, branch, fetched.has(repo.path));
			if (!from) throw new CodeReadError(branch, repo.name, `Neither origin/${branch} nor ${branch} is in it.`);
			let commit: string;
			try {
				commit = (await git(repo.path, ["rev-parse", "--verify", `${from.ref}^{commit}`])).stdout.trim();
			} catch (error) {
				throw new CodeReadError(branch, repo.name, gitError(error));
			}
			const target = join(dir, repo.name);
			await mkdir(target);
			const archive = `${dir}-${repo.name}.tar`;
			try {
				await git(repo.path, ["archive", "--format=tar", "-o", archive, commit]);
				await runTool("tar", ["-xf", archive, "-C", target]);
			} catch (error) {
				throw new CodeReadError(branch, repo.name, gitError(error));
			} finally {
				await rm(archive, { force: true });
			}
			const name = await github.repoName(repo.path).catch(() => null);
			code.push({
				repo: repo.name,
				branch,
				commit,
				source: from.source,
				...(name ? { url: `https://github.com/${name}/commit/${commit}` } : {}),
			});
		}
		await runTool("chmod", ["-R", "a-w", dir]);
	} catch (error) {
		await removeSnapshot(dir);
		throw error;
	}
	return { dir, code };
}

/** One repository's line in the prompt (CMP-10), like "server: main at 098e623". */
export function codeReadText(read: CodeRead): string {
	const line = `${read.repo}: ${read.branch} at ${read.commit.slice(0, 7)}`;
	if (read.source === "last-fetch") return `${line} (origin/${read.branch} as of the last fetch)`;
	if (read.source === "local") return `${line} (the local ${read.branch}: it was never fetched)`;
	return line;
}

/**
 * What a report line adds when a repository's code didn't come from a fresh fetch of origin (REP-43, CMP-87), or ""
 * when it did.
 */
export function codeSourceText(read: CodeRead): string {
	if (read.source === "last-fetch") return `origin/${read.branch} as of the last fetch`;
	if (read.source === "local") return `the local ${read.branch}, never fetched`;
	return "";
}
