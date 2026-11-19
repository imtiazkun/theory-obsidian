import { basename } from "path";
import type { GitHub, PullRequestState } from "../src/github";
import { git } from "../src/vault";

export interface FakeIssue {
	repo: string;
	number: number;
	url: string;
	title: string;
	body: string;
	labels: string[];
	state: "open" | "closed";
	closedAs?: "completed" | "not planned";
	/** The epic it was linked to, as "{repo}#{number}". */
	parent?: string;
	inProject?: string;
}

export interface FakePullRequest {
	repo: string;
	url: string;
	head: string;
	base: string;
	title: string;
	body: string;
	state: PullRequestState;
}

/**
 * A GitHub that lives in memory, so tests never reach GitHub (TEST-6). Repositories are named after their folder,
 * as `team/{folder}`. Merging a pull request pushes its head onto its base in the repository's real `origin`, as
 * a fast-forward, so the next branch sees the merged work.
 */
export class FakeGitHub implements GitHub {
	issues: FakeIssue[] = [];
	pullRequests: FakePullRequest[] = [];
	labels = new Map<string, string[]>();
	calls: string[] = [];
	loggedIn = true;
	/** Folders of repositories without a GitHub origin. */
	noOrigin = new Set<string>();
	projectError: string | null = null;
	/** Makes the nth call of a method fail once with this message, counted from 1. */
	failures = new Map<string, { at: number; message: string }>();
	private counts = new Map<string, number>();
	private next = 1;

	private call(name: string, detail: string) {
		this.calls.push(`${name} ${detail}`);
		const n = (this.counts.get(name) ?? 0) + 1;
		this.counts.set(name, n);
		const failure = this.failures.get(name);
		if (failure && failure.at === n) {
			this.failures.delete(name);
			throw new Error(failure.message);
		}
	}

	private repo(repoPath: string) {
		return basename(repoPath);
	}

	async authProblem() {
		this.call("authProblem", "");
		return this.loggedIn ? null : "The GitHub CLI (gh) isn't logged in. Run gh auth login.";
	}

	async repoName(repoPath: string) {
		return this.noOrigin.has(this.repo(repoPath)) ? null : `team/${this.repo(repoPath)}`;
	}

	async checkProject(projectUrl: string) {
		this.call("checkProject", projectUrl);
		if (this.projectError) throw new Error(this.projectError);
	}

	async ensureLabel(repoPath: string, label: string) {
		this.call("ensureLabel", `${this.repo(repoPath)} ${label}`);
		const labels = this.labels.get(this.repo(repoPath)) ?? [];
		if (!labels.includes(label)) {
			labels.push(label);
			this.calls.push(`createLabel ${this.repo(repoPath)} ${label}`);
		}
		this.labels.set(this.repo(repoPath), labels);
	}

	async createIssue(repoPath: string, issue: { title: string; body: string; labels: string[] }) {
		const repo = this.repo(repoPath);
		this.call("createIssue", `${repo} ${issue.title}`);
		const number = this.next++;
		const url = `https://github.com/team/${repo}/issues/${number}`;
		this.issues.push({ repo, number, url, ...issue, state: "open" });
		return { number, url };
	}

	issue(repo: string, number: number): FakeIssue {
		const found = this.issues.find((i) => i.repo === repo && i.number === number);
		if (!found) throw new Error(`No issue ${repo}#${number}`);
		return found;
	}

	async addSubIssue(epicRepoPath: string, epicNumber: number, subRepoPath: string, subNumber: number) {
		this.call("addSubIssue", `${this.repo(subRepoPath)}#${subNumber} to ${this.repo(epicRepoPath)}#${epicNumber}`);
		this.issue(this.repo(subRepoPath), subNumber).parent = `${this.repo(epicRepoPath)}#${epicNumber}`;
	}

	async addToProject(projectUrl: string, issueUrl: string) {
		this.call("addToProject", issueUrl);
		const issue = this.issues.find((i) => i.url === issueUrl);
		if (issue) issue.inProject = projectUrl;
	}

	async closeIssue(repoPath: string, number: number, reason: "completed" | "not planned") {
		this.call("closeIssue", `${this.repo(repoPath)}#${number} ${reason}`);
		const issue = this.issue(this.repo(repoPath), number);
		issue.state = "closed";
		issue.closedAs = reason;
	}

	async issueState(repoPath: string, number: number) {
		return this.issue(this.repo(repoPath), number).state;
	}

	async openPullRequest(repoPath: string, pr: { head: string; base: string; title: string; body: string }) {
		const repo = this.repo(repoPath);
		this.call("openPullRequest", `${repo} ${pr.head} -> ${pr.base}`);
		const url = `https://github.com/team/${repo}/pull/${this.next++}`;
		this.pullRequests.push({ repo, url, ...pr, state: "open" });
		return url;
	}

	async mergePullRequest(repoPath: string, url: string) {
		this.call("mergePullRequest", url);
		const pr = this.pullRequests.find((p) => p.url === url);
		if (!pr) throw new Error(`No pull request ${url}`);
		await git(repoPath, ["push", "--quiet", "origin", `refs/remotes/origin/${pr.head}:refs/heads/${pr.base}`]);
		pr.state = "merged";
	}

	async pullRequestState(_repoPath: string, url: string) {
		return this.pullRequests.find((p) => p.url === url)?.state ?? "open";
	}
}
