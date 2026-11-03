import { execFile } from "child_process";
import { promisify } from "util";
import { TOOL_PATH, git } from "./vault";

const run = promisify(execFile);

export type PullRequestState = "draft" | "open" | "merged" | "closed";

/** A pull request opened from Create PR for one repository's compile branch. */
export interface PullRequest {
	/** Absolute path of the code repository. */
	repoPath: string;
	/** The repository's name in the project folder. */
	repo: string;
	branch: string;
	base: string;
	url: string;
	/** As last seen on GitHub. Refreshed as `src/pr-states.ts` says. */
	state: PullRequestState;
}

/** Runs the GitHub CLI in `cwd`, with the same PATH as every other subprocess. */
export async function gh(cwd: string, args: string[]) {
	try {
		return await run("gh", args, { cwd, env: { ...process.env, PATH: TOOL_PATH }, maxBuffer: 16 * 1024 * 1024 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error("The GitHub CLI (gh) isn't installed.");
		}
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw new Error(stderr || (error instanceof Error ? error.message : String(error)));
	}
}

/** Null when `gh` is installed and logged in, else the reason it can't be used. */
export async function ghProblem(cwd: string): Promise<string | null> {
	try {
		await gh(cwd, ["auth", "status"]);
		return null;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return message.includes("isn't installed") ? message : "The GitHub CLI (gh) isn't logged in. Run gh auth login.";
	}
}

/** The web address of the repository's `origin` on GitHub, or null when it has none. */
export async function githubOrigin(repoPath: string): Promise<string | null> {
	let url: string;
	try {
		url = (await git(repoPath, ["remote", "get-url", "origin"])).stdout.trim();
	} catch {
		return null;
	}
	const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
	return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}

/** True when the repository has an `origin`, on GitHub or not. */
export async function hasOrigin(repoPath: string): Promise<boolean> {
	try {
		await git(repoPath, ["remote", "get-url", "origin"]);
		return true;
	} catch {
		return false;
	}
}

function stateOf(pr: { state?: string; isDraft?: boolean }): PullRequestState {
	if (pr.state === "MERGED") return "merged";
	if (pr.state === "CLOSED") return "closed";
	return pr.isDraft ? "draft" : "open";
}

/** The pull request's state on GitHub now. */
export async function pullRequestState(repoPath: string, url: string): Promise<PullRequestState> {
	const { stdout } = await gh(repoPath, ["pr", "view", url, "--json", "state,isDraft"]);
	return stateOf(JSON.parse(stdout));
}

/** The newest pull request on GitHub for `branch`, in any state, or null when there is none or gh can't tell. */
export async function branchPullRequest(
	repoPath: string,
	branch: string,
): Promise<{ url: string; state: PullRequestState } | null> {
	try {
		const { stdout } = await gh(repoPath, ["pr", "list", "--head", branch, "--state", "all", "--json", "url,state,isDraft", "--limit", "1"]);
		const [pr] = JSON.parse(stdout) as { url: string; state: string; isDraft: boolean }[];
		return pr ? { url: pr.url, state: stateOf(pr) } : null;
	} catch {
		return null;
	}
}

/** Branch names on `origin`, as git last saw them. Never fetches. */
export async function remoteBranches(repoPath: string): Promise<string[]> {
	try {
		const { stdout } = await git(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/"]);
		return stdout
			.split("\n")
			.map((name) => name.trim().replace(/^origin\//, ""))
			.filter((name) => name && name !== "HEAD" && name !== "origin");
	} catch {
		return [];
	}
}

export interface NewPullRequest {
	branch: string;
	base: string;
	title: string;
	body: string;
	draft: boolean;
	/** GitHub usernames. */
	reviewers: string[];
}

/** Pushes the branch to `origin` and opens a pull request for it. Returns its web address. */
export async function createPullRequest(repoPath: string, pr: NewPullRequest): Promise<string> {
	await git(repoPath, ["push", "-u", "origin", pr.branch]).catch((error) => {
		throw new Error((error as { stderr?: string }).stderr?.trim() || String(error));
	});
	const args = ["pr", "create", "--head", pr.branch, "--base", pr.base, "--title", pr.title, "--body", pr.body];
	if (pr.draft) args.push("--draft");
	if (pr.reviewers.length > 0) args.push("--reviewer", pr.reviewers.join(","));
	const { stdout } = await gh(repoPath, args);
	const url = stdout.trim().split("\n").pop() ?? "";
	if (!/^https?:\/\//.test(url)) throw new Error("gh didn't return the pull request's address.");
	return url;
}

/** Replaces the pull request's body. */
export async function editPullRequestBody(repoPath: string, url: string, body: string): Promise<void> {
	await gh(repoPath, ["pr", "edit", url, "--body", body]);
}

/** The pull request's body as it is on GitHub now. */
export async function pullRequestBody(repoPath: string, url: string): Promise<string> {
	const { stdout } = await gh(repoPath, ["pr", "view", url, "--json", "body"]);
	return String(JSON.parse(stdout).body ?? "");
}
