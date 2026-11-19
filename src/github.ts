import { execFile } from "child_process";
import { promisify } from "util";
import { toolPath } from "./tool-path";
import { git } from "./vault";

const run = promisify(execFile);

export type PullRequestState = "draft" | "open" | "merged" | "closed";

/** A pull request for one compile branch: opened by a build (BLD-14, BLD-16), or from Create PR for an epic branch. */
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
		return await run("gh", args, { cwd, env: { ...process.env, PATH: toolPath() }, maxBuffer: 16 * 1024 * 1024 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error("The GitHub CLI (gh) isn't installed.");
		}
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw new Error(stderr || (error instanceof Error ? error.message : String(error)));
	}
}

/**
 * Parses a list `gh` printed with `--json`. Some list commands, like `gh label list --search`, print nothing
 * instead of `[]` when nothing matches, so empty output is an empty list.
 */
export function parseJsonList<T>(stdout: string): T[] {
	return stdout.trim() ? (JSON.parse(stdout) as T[]) : [];
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

/**
 * True when a pull request whose head is `head` was opened from this `branch`, not from an older branch that
 * had the same name. Recompiling a revision reuses its branch name. The head must be on the branch. When this
 * repository doesn't have the head commit, only an open or draft pull request counts, because GitHub allows
 * one of those per branch name. Without a known head, the name alone decides.
 */
export async function isFromBranch(
	repoPath: string,
	branch: string,
	head: string | undefined,
	state: PullRequestState,
): Promise<boolean> {
	if (!head) return true;
	try {
		await git(repoPath, ["cat-file", "-e", `${head}^{commit}`]);
	} catch {
		return state === "open" || state === "draft";
	}
	try {
		await git(repoPath, ["merge-base", "--is-ancestor", head, `refs/heads/${branch}`]);
		return true;
	} catch {
		return false;
	}
}

/**
 * The newest pull request on GitHub opened from this `branch`, in any state, or null when there is none or
 * gh can't tell. Pull requests from an older branch of the same name are skipped (see `isFromBranch`).
 */
export async function branchPullRequest(
	repoPath: string,
	branch: string,
): Promise<{ url: string; state: PullRequestState } | null> {
	let prs: { url: string; state: string; isDraft: boolean; headRefOid: string }[];
	try {
		const { stdout } = await gh(repoPath, ["pr", "list", "--head", branch, "--state", "all", "--json", "url,state,isDraft,headRefOid", "--limit", "20"]);
		prs = parseJsonList(stdout);
	} catch {
		return null;
	}
	for (const pr of prs) {
		const state = stateOf(pr);
		if (await isFromBranch(repoPath, branch, pr.headRefOid, state)) return { url: pr.url, state };
	}
	return null;
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

/** A GitHub Project, from its URL like `https://github.com/orgs/team/projects/3` or `…/users/me/projects/3`. */
export interface ProjectRef {
	owner: string;
	number: number;
}

/** The project's owner and number, or null when the URL isn't a GitHub Project's. */
export function parseProjectUrl(url: string): ProjectRef | null {
	const match = /^https?:\/\/github\.com\/(?:orgs|users)\/([^/\s]+)\/projects\/(\d+)\/?(?:[?#].*)?$/.exec(url.trim());
	return match ? { owner: match[1], number: Number(match[2]) } : null;
}

/** An issue on GitHub. */
export interface IssueRef {
	number: number;
	url: string;
}

/**
 * Everything Compile and Build ask of GitHub. The plugin uses `ghGitHub`, which runs `gh`; tests pass a fake,
 * because they must never reach GitHub (TEST-6). Every method throws with the reason when GitHub refuses.
 */
export interface GitHub {
	/** Null when `gh` is installed and logged in, else the reason it can't be used. */
	authProblem(cwd: string): Promise<string | null>;
	/** `owner/name` of the repository's GitHub `origin`, or null when it has none. */
	repoName(repoPath: string): Promise<string | null>;
	/** Throws with the reason when the GitHub Project can't be reached. */
	checkProject(projectUrl: string, cwd: string): Promise<void>;
	/** Creates the label in the repository when it is missing. */
	ensureLabel(repoPath: string, label: string): Promise<void>;
	createIssue(repoPath: string, issue: { title: string; body: string; labels: string[] }): Promise<IssueRef>;
	/** Links `sub` as a native sub-issue of the epic. */
	addSubIssue(epicRepoPath: string, epicNumber: number, subRepoPath: string, subNumber: number): Promise<void>;
	addToProject(projectUrl: string, issueUrl: string, cwd: string): Promise<void>;
	closeIssue(repoPath: string, number: number, reason: "completed" | "not planned"): Promise<void>;
	issueState(repoPath: string, number: number): Promise<"open" | "closed">;
	/** Opens a pull request for a branch already pushed. Returns its web address. */
	openPullRequest(repoPath: string, pr: { head: string; base: string; title: string; body: string }): Promise<string>;
	/** Merges the pull request with a merge commit. */
	mergePullRequest(repoPath: string, url: string): Promise<void>;
	pullRequestState(repoPath: string, url: string): Promise<PullRequestState>;
}

function projectOf(url: string): ProjectRef {
	const project = parseProjectUrl(url);
	if (!project) throw new Error("It isn't a GitHub Project URL, like https://github.com/orgs/team/projects/1.");
	return project;
}

/** The GitHub the plugin uses: every call runs `gh`. */
export const ghGitHub: GitHub = {
	async authProblem(cwd) {
		return ghProblem(cwd);
	},
	async repoName(repoPath) {
		const url = await githubOrigin(repoPath);
		return url ? url.replace("https://github.com/", "") : null;
	},
	async checkProject(projectUrl, cwd) {
		const { owner, number } = projectOf(projectUrl);
		await gh(cwd, ["project", "view", String(number), "--owner", owner, "--format", "json"]);
	},
	async ensureLabel(repoPath, label) {
		const { stdout } = await gh(repoPath, ["label", "list", "--search", label, "--json", "name", "--limit", "100"]);
		const names = parseJsonList<{ name: string }>(stdout).map((l) => l.name.toLowerCase());
		if (names.includes(label.toLowerCase())) return;
		await gh(repoPath, ["label", "create", label, "--description", "A theory.md compile's epic"]);
	},
	async createIssue(repoPath, issue) {
		const args = ["issue", "create", "--title", issue.title, "--body", issue.body];
		for (const label of issue.labels) args.push("--label", label);
		const { stdout } = await gh(repoPath, args);
		const url = stdout.trim().split("\n").pop() ?? "";
		const number = Number(/\/issues\/(\d+)$/.exec(url)?.[1]);
		if (!number) throw new Error("gh didn't return the issue's address.");
		return { number, url };
	},
	async addSubIssue(epicRepoPath, epicNumber, subRepoPath, subNumber) {
		const sub = await ghGitHub.repoName(subRepoPath);
		const epic = await ghGitHub.repoName(epicRepoPath);
		if (!sub || !epic) throw new Error("The repository has no GitHub origin.");
		const { stdout } = await gh(subRepoPath, ["api", `repos/${sub}/issues/${subNumber}`, "--jq", ".id"]);
		await gh(epicRepoPath, ["api", "-X", "POST", `repos/${epic}/issues/${epicNumber}/sub_issues`, "-F", `sub_issue_id=${stdout.trim()}`]);
	},
	async addToProject(projectUrl, issueUrl, cwd) {
		const { owner, number } = projectOf(projectUrl);
		await gh(cwd, ["project", "item-add", String(number), "--owner", owner, "--url", issueUrl]);
	},
	async closeIssue(repoPath, number, reason) {
		await gh(repoPath, ["issue", "close", String(number), "--reason", reason]);
	},
	async issueState(repoPath, number) {
		const { stdout } = await gh(repoPath, ["issue", "view", String(number), "--json", "state"]);
		return JSON.parse(stdout).state === "OPEN" ? "open" : "closed";
	},
	async openPullRequest(repoPath, pr) {
		const { stdout } = await gh(repoPath, ["pr", "create", "--head", pr.head, "--base", pr.base, "--title", pr.title, "--body", pr.body]);
		const url = stdout.trim().split("\n").pop() ?? "";
		if (!/^https?:\/\//.test(url)) throw new Error("gh didn't return the pull request's address.");
		return url;
	},
	async mergePullRequest(repoPath, url) {
		await gh(repoPath, ["pr", "merge", url, "--merge"]);
	},
	pullRequestState,
};
