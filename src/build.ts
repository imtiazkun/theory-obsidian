import { spawn } from "child_process";
import { recompiledBy } from "./recompile";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { plainProblem } from "./anchor";
import type { TokenUsage } from "./costs";
import {
	BranchCommit,
	CodeRepo,
	DivergedError,
	branchCommits,
	branchExists,
	epicBranchName,
	issueBranchName,
	currentBranch,
	defaultBranch,
	dirtyRepos,
	fastForwardTo,
	gitError,
	isMerged,
	pushBranch,
	refExists,
	uniqueBranchName,
	upstreamOf,
} from "./branches";
import {
	AgentSession,
	AgentSettings,
	BUILD_SCHEMA,
	CompileReport,
	PermissionAnswer,
	PermissionRequest,
	SIGN_IN_SUMMARY,
	appendLog,
	checkModel,
	checkedQuestions,
	createSnapshot,
	guardModel,
	noAnswerProblem,
	removeSnapshot,
	requireGitHub,
	signInFailed,
	startProblem,
	startSession,
} from "./compile";
import { checkProblems } from "./anchor";
import { type GitHub, type PullRequest, ghGitHub } from "./github";
import { type IssueRecord, fillIssueBodies } from "./plan";
import { NO_PROMPT_ENV } from "./pull";
import { toolPath } from "./tool-path";
import { git } from "./vault";

/** How a build ended, or that it still runs. */
export type BuildStatus = "running" | "finished" | "stopped" | "cancelled";

/** An epic branch in one repository (BLD-11, BLD-15). */
export interface EpicBranch {
	repo: string;
	repoPath: string;
	branch: string;
	/** The repository's default branch: where the engineer merges the epic branch (BLD-18). */
	base: string;
}

/** What the build waits for the engineer to answer. */
export type BuildQuestion =
	/** An issue failed: Retry, Skip (sub-issues only) or Stop (BLD-22). */
	| { kind: "failure"; issue: number; reason: string; canSkip: boolean }
	/** The build was cancelled: keep or delete the current issue's branch (BLD-23). */
	| { kind: "cancel"; issue: number; branch: string };

export type BuildChoice = "retry" | "skip" | "stop" | "keep" | "delete";

/** The build of one compile's issues, kept in that compile's report (BLD-3). */
export interface BuildRecord {
	status: BuildStatus;
	startedAt: string;
	finishedAt?: string;
	/** Set for an epic once its branches exist. */
	epicBranches?: EpicBranch[];
	/** Set while the build waits for the engineer. */
	waiting?: BuildQuestion;
	/** "Epic #{n} is built on {branch}. …" once every sub-issue is built (BLD-17). */
	message?: string;
	/** "Skipped and still open: {issues}." when an epic's build finished with sub-issues skipped (BLD-28). */
	skippedLine?: string;
	/** This build's tokens in four parts, every issue's added up, kept apart from the compile's (REP-56). */
	tokens?: TokenUsage;
}

/** What Build says when a compile has nothing left to build (BLD-27). */
export const NOTHING_LEFT = "Every issue of this compile is built.";

/** Thrown by `startBuild` before anything changes when every issue of the compile is built (BLD-27). Not a failure. */
export class NothingLeftError extends Error {
	constructor() {
		super(NOTHING_LEFT);
	}
}

export interface BuildOptions extends AgentSettings {
	vaultPath: string;
	projectFolder: string;
	/** The GitHub Project, as its URL (CFG-40). The build doesn't start without it (BLD-5). */
	githubProject: string;
	/** How the plugin reaches GitHub. `gh` when unset; tests pass a fake (TEST-6). */
	github?: GitHub;
	onPermissionRequest?: (request: PermissionRequest) => void;
}

export interface BuildRun {
	report: CompileReport;
	done: Promise<CompileReport>;
	/** Permission requests waiting for an answer in the issue being built. */
	requests(): PermissionRequest[];
	answer(id: string, answer: PermissionAnswer): void;
	/** Stops Claude, then asks whether to keep the current issue's branch (BLD-23). */
	cancel(): void;
	/** Answers the question in `report.build.waiting`. */
	choose(choice: BuildChoice): void;
}

export { epicBranchName, issueBranchName } from "./branches";

/** What a build of a recompiled compile is refused with: its issues are the recompile's now (CMP-83, REP-41). */
export const RECOMPILED = "This compile has been recompiled. Build the issues of the new compile.";

/**
 * The newest report whose compile created issues, which the command "Build" builds (BLD-1). Never a recompiled
 * compile: the recompile's report owns its issues (CMP-83).
 */
export function buildableReport(reports: CompileReport[]): CompileReport | null {
	return (
		reports.find(
			(r) => r.status === "succeeded" && r.issues?.some((i) => i.kind === "issue" && i.number !== undefined) && !recompiledBy(r, reports),
		) ?? null
	);
}

/** "{n} issues are ready. Build them now?" (BLD-1). */
export function buildPromptText(report: CompileReport): string {
	const n = (report.issues ?? []).filter((i) => i.kind === "issue").length;
	return `${n} ${n === 1 ? "issue is" : "issues are"} ready. Build ${n === 1 ? "it" : "them"} now?`;
}

/** True when the command exists, wherever it is on the PATH. */
function commandFound(command: string): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn(command, ["--version"], { env: { ...process.env, PATH: toolPath() }, stdio: "ignore" });
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			resolve(true);
		}, 10_000);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve((error as NodeJS.ErrnoException).code !== "ENOENT");
		});
		child.on("close", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

/**
 * Open work from an earlier build in this repository, or null (BLD-8): an open pull request, or an epic branch not
 * merged into its base whose pull request isn't merged or closed. Pull request states come from GitHub, else the reports.
 * `reports` must leave out the compile being built: its own work is continued, not in the way (BLD-27).
 */
export async function openWork(github: GitHub, repo: CodeRepo, reports: CompileReport[]): Promise<string | null> {
	for (const report of reports) {
		for (const pr of report.pullRequests ?? []) {
			if (pr.repoPath !== repo.path || (pr.state !== "open" && pr.state !== "draft")) continue;
			pr.state = await github.pullRequestState(pr.repoPath, pr.url).catch(() => pr.state);
			if (pr.state === "open" || pr.state === "draft") return pr.url;
		}
	}
	for (const report of reports) {
		for (const epic of report.build?.epicBranches ?? []) {
			if (epic.repoPath !== repo.path) continue;
			const exists = (await branchExists(repo.path, epic.branch)) || (await refExists(repo.path, `refs/remotes/origin/${epic.branch}`));
			if (!exists) continue;
			const pr = (report.pullRequests ?? []).find((p) => p.repoPath === repo.path && p.branch === epic.branch);
			if (pr?.state === "merged" || pr?.state === "closed") continue;
			if (await isMerged(repo.path, epic.branch, epic.base)) continue;
			return epic.branch;
		}
	}
	return null;
}

/** The `instructions.md` in a repository's model folder, matched ignoring case, or null when it has none. */
async function modelInstructions(snapshot: string, repo: string): Promise<{ path: string; text: string } | null> {
	const entries = await readdir(join(snapshot, repo)).catch(() => [] as string[]);
	const name = entries.find((entry) => entry.toLowerCase() === "instructions.md");
	if (!name) return null;
	const text = await readFile(join(snapshot, repo, name), "utf8").catch(() => null);
	return text === null ? null : { path: `${repo}/${name}`, text };
}

/** The prompt for one issue: what BLD-20 says Claude receives, and the rules of BLD-21. */
export function buildPrompt(params: {
	snapshot: string;
	head: string;
	issue: IssueRecord;
	branch: string;
	instructions: { path: string; text: string } | null;
}): string {
	const { snapshot, head, issue, branch, instructions } = params;
	return `You are building one GitHub issue planned from a theoretical model.

The theoretical model is a set of notes, written only by humans, that describes a software ecosystem: what it does and why. A compile read the model and planned the work as GitHub issues. Your job is to change the code in this repository (the current directory) so that it does what this issue says. Its rules are its acceptance criteria.

The model at revision ${head} is in this directory: ${snapshot}

## The issue

Repository: ${issue.repo}
Issue: #${issue.number}
Title: ${issue.title}
Rules it covers: ${issue.rules.length > 0 ? issue.rules.join(", ") : "none listed"}
Branch checked out: ${branch}

${issue.body}

## Rules

- The model is read-only. Never create, edit, move or delete anything in the model directory, and never write to the Obsidian vault it came from. Writing to the model is forbidden.
- The model is the source of truth. If the code disagrees with the model, change the code.
- Build only what this issue covers, and change files only in this repository.
- Before changing the repository, read its AGENTS.md (and CLAUDE.md, if there is one) and \`instructions.md\` in its folder in the model directory, and follow them, including how to test. When they disagree, the model's \`instructions.md\` wins.
- End every commit message with the trailers \`Model-Revision: ${head}\` and \`Refs #${issue.number}\`.
- If the model is unclear, don't guess. Add a question to \`questions\`, naming the model files it is about with paths relative to the model directory, with \`anchors\` pointing at the rule that needs updating.
- Put anything that went wrong (steps you couldn't do) in \`problems\`. When a problem comes from something in the model, give it \`anchors\`: the model file, the heading it sits under, and a short quote copied exactly from the note (under 200 characters).
- Set \`status\` to "failed" if the code doesn't do what the issue's rules say at the end.
- Commit on the branch that is checked out (${branch}). Never create, switch, merge or push branches, and never touch GitHub.
- Your \`summary\` opens the pull request's body, so write it for the person who reviews the change.
${instructions ? `\n## Instructions for this repository (${instructions.path} in the model directory)\n\n${instructions.text.trim()}\n` : ""}`;
}

/**
 * Starts building the issues of one compile (BLD-1, BLD-2). Throws before anything changes when a check fails
 * (BLD-5 to BLD-8), with the message after "Build failed: ". After that, every outcome is in `report.build`.
 */
export async function startBuild(
	options: BuildOptions,
	report: CompileReport,
	reports: CompileReport[],
	onUpdate: (report: CompileReport) => void,
): Promise<BuildRun> {
	const github = options.github ?? ghGitHub;
	// A recompiled compile's issues are built from the recompile's report, in the new plan's order (CMP-83).
	if (recompiledBy(report, reports)) throw new Error(RECOMPILED);
	const issues = (report.issues ?? []).filter((i) => i.kind === "issue" && i.number !== undefined);
	const epic = report.issues?.find((i) => i.kind === "epic" && i.number !== undefined) ?? null;
	if (issues.length === 0) throw new Error("This compile created no issues to build.");
	// BLD-27: issues built before keep their state, and a compile whose every issue is built has nothing left.
	if (issues.every((i) => i.build === "built")) throw new NothingLeftError();
	const repos: CodeRepo[] = [];
	for (const issue of issues) if (!repos.some((r) => r.path === issue.repoPath)) repos.push({ name: issue.repo, path: issue.repoPath });

	// BLD-5: the agent, gh and the GitHub Project.
	if (options.agent === "acp") {
		if (!options.agentCommand?.trim()) throw new Error("Set the agent command in theory.md settings first.");
	} else if (!(await commandFound(options.claudeCommand || "claude"))) {
		throw new Error(`Couldn't find the Claude Code CLI ("${options.claudeCommand}"). Set its path in theory.md settings.`);
	}
	await requireGitHub(github, options.projectFolder, repos, options.githubProject);

	// BLD-6: the engineer's unfinished work must never end up on a build branch.
	const dirty = await dirtyRepos(options.projectFolder, repos);
	if (dirty.length > 0) throw new Error(`These repositories have uncommitted changes: ${dirty.join(", ")}. Commit or stash them first.`);

	// BLD-7: Claude builds on the newest code.
	const defaults = new Map<string, string>();
	for (const repo of repos) {
		const base = await defaultBranch(repo.path);
		if (!base) throw new Error(`${repo.name} has no default branch. Commit to it first.`);
		defaults.set(repo.path, base);
		try {
			await fastForwardTo(repo.path, base, await upstreamOf(repo.path, base));
		} catch (error) {
			if (!(error instanceof DivergedError)) throw new Error(gitError(error));
			throw new Error(`${base} in ${repo.name} and origin/${base} both have new commits. Pull with rebase in git, then build again.`);
		}
	}

	// BLD-8: new work starts from code that holds every earlier change. This compile's own work is continued (BLD-27).
	const others = reports.filter((r) => r !== report && r.id !== report.id);
	for (const repo of repos) {
		const open = await openWork(github, repo, others);
		if (open) throw new Error(`Finish the open work in ${repo.name} first: ${open}.`);
	}

	// BLD-9 and BLD-27: only issues still open with no open pull request are built, in the plan's order. A sub-issue
	// this compile's build closed stays built. When GitHub can't say, the issue counts as open.
	const toBuild: IssueRecord[] = [];
	const skippedClosed: string[] = [];
	const closed = new Set<IssueRecord>();
	for (const issue of issues) {
		if (issue.build === "built") continue;
		const state = await github.issueState(issue.repoPath, issue.number as number).catch(() => "open");
		if (state === "closed") {
			closed.add(issue);
			issue.build = "skipped";
			const line = `Skipped ${issue.repo}#${issue.number}: the issue is closed.`;
			if (!report.problems.some((p) => p.text === line)) skippedClosed.push(line);
			continue;
		}
		const pr = (report.pullRequests ?? []).find((p) => p.repoPath === issue.repoPath && p.branch === issue.branch);
		if (pr && (pr.state === "open" || pr.state === "draft")) {
			pr.state = await github.pullRequestState(pr.repoPath, pr.url).catch(() => pr.state);
			if (pr.state === "open" || pr.state === "draft") continue;
		}
		issue.build = "waiting";
		toBuild.push(issue);
	}
	if (toBuild.length === 0 && skippedClosed.length === 0) throw new NothingLeftError();
	// REP-50: another engineer's compile, read from `.compiles/`, has no issue bodies. Claude gets them from GitHub.
	await fillIssueBodies(github, toBuild);

	const snapshot = await createSnapshot(options.vaultPath, report.toCommit);
	// BLD-27: a build of a compile built before continues its record, epic branches included.
	const build: BuildRecord = report.build ?? { status: "running", startedAt: "" };
	build.status = "running";
	build.startedAt = new Date().toISOString();
	delete build.finishedAt;
	delete build.waiting;
	delete build.message;
	delete build.skippedLine;
	// REP-56: the build before this one keeps its tokens in `report.builds`; this build counts its own.
	delete build.tokens;
	report.build = build;
	report.problems.push(...skippedClosed.map(plainProblem));
	for (const line of skippedClosed) appendLog(report, line);
	const update = () => onUpdate(report);
	const log = (line: string) => {
		appendLog(report, line);
		update();
	};

	let cancelled = false;
	let session: AgentSession | null = null;
	let answerQuestion: ((choice: BuildChoice) => void) | null = null;
	/** Asks the engineer and waits for the answer. */
	const ask = (question: BuildQuestion) =>
		new Promise<BuildChoice>((resolve) => {
			build.waiting = question;
			answerQuestion = (choice) => {
				answerQuestion = null;
				delete build.waiting;
				resolve(choice);
			};
			update();
		});

	const indexOf = (issue: IssueRecord) => (report.issues ?? []).indexOf(issue);
	const ref = (issue: IssueRecord) => `${issue.repo}#${issue.number}`;
	const pullRequests = () => (report.pullRequests ??= []);

	/** The epic as a sub-issue in `repoPath` must write it (BLD-26), the repositories compared by their GitHub names. */
	const epicRef = async (repoPath: string) => {
		if (!epic?.number) return "";
		const [epicName, name] = await Promise.all([
			github.repoName(epic.repoPath).catch(() => null),
			github.repoName(repoPath).catch(() => null),
		]);
		return issueRef(epic.number, epicName, name, epic.url);
	};

	/** Brings the local epic branch up to `origin`, where each sub-issue's pull request was merged. */
	const syncEpic = async (repoPath: string, branch: string) => {
		await git(repoPath, ["fetch", "--quiet", "--no-tags", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`], NO_PROMPT_ENV);
		await fastForwardTo(repoPath, branch, `refs/remotes/origin/${branch}`);
	};

	/** Builds one issue. Returns null when it was built, "cancelled", or the reason it failed (BLD-22). */
	const buildIssue = async (issue: IssueRecord): Promise<string | null | "cancelled"> => {
		const { repoPath } = issue;
		const base = (epic ? build.epicBranches?.find((b) => b.repoPath === repoPath)?.branch : defaults.get(repoPath)) as string;
		if ((await dirtyRepos(options.projectFolder, [{ name: issue.repo, path: repoPath }])).length > 0) {
			return `${issue.repo} has uncommitted changes, so ${ref(issue)} couldn't start. Commit or stash them, then retry.`;
		}
		try {
			if (epic) await syncEpic(repoPath, base);
			// BLD-27: the branch an earlier build of this compile made is reused, from origin when it's only there.
			if (issue.branch && !(await branchExists(repoPath, issue.branch)) && (await refExists(repoPath, `refs/remotes/origin/${issue.branch}`))) {
				await git(repoPath, ["branch", issue.branch, `refs/remotes/origin/${issue.branch}`]);
			}
			if (!issue.branch || !(await branchExists(repoPath, issue.branch))) {
				// The plugin makes and switches every branch, never Claude (BLD-13, BLD-16).
				issue.branch = await uniqueBranchName([repoPath], issueBranchName(issue));
				await git(repoPath, ["checkout", "--quiet", "-b", issue.branch, base]);
				log(`Created ${issue.branch} in ${issue.repo} from ${base}`);
			} else {
				await git(repoPath, ["checkout", "--quiet", issue.branch]);
				log(`Checked out ${issue.branch} in ${issue.repo}`);
			}
		} catch (error) {
			return `Couldn't check out the branch for ${ref(issue)}: ${gitError(error)}`;
		}
		const branch = issue.branch as string;
		update();

		const guard = await guardModel(options.vaultPath, snapshot);
		const current = startSession({
			settings: options,
			cwd: repoPath,
			snapshot,
			protectedPaths: [options.vaultPath, snapshot],
			prompt: buildPrompt({ snapshot, head: report.toCommit, issue, branch, instructions: await modelInstructions(snapshot, issue.repo) }),
			schema: BUILD_SCHEMA,
			readOnly: false,
			what: "build",
			report,
			usageTo: build,
			onUpdate: update,
			onPermissionRequest: options.onPermissionRequest,
		});
		session = current;
		const outcome = await current.done;
		session = null;
		const checked = await checkModel(guard, "build");
		const prefix = `[${ref(issue)}] `;
		report.problems.push(...checked.problems.map((p) => ({ ...p, text: prefix + p.text })));
		report.problems.push(...outcome.skipped.map((text) => plainProblem(prefix + text)));
		if (cancelled) return "cancelled";
		if (outcome.error) return startProblem(outcome.error, options);
		const structured = outcome.result?.structured;
		if (!structured) {
			if (options.agent !== "acp" && signInFailed(`${outcome.result?.text ?? ""}\n${outcome.stderr}`)) return SIGN_IN_SUMMARY;
			return noAnswerProblem(outcome, options);
		}
		issue.summary = structured.summary;
		report.changes.push(...(structured.changes ?? []).map((c) => prefix + c));
		report.problems.push(...(await checkProblems(checked.intact ? snapshot : null, structured.problems)).map((p) => ({ ...p, text: prefix + p.text })));
		report.questions.push(...(await checkedQuestions(structured, checked.intact ? snapshot : null)));
		update();
		if (!checked.intact) return "Claude tried to change the model snapshot.";
		if (structured.status !== "succeeded" || outcome.result?.isError) return `Claude reported failed: ${structured.summary}`;
		if ((await currentBranch(repoPath)) !== branch) return `Claude switched away from ${branch}. Claude must commit on the branch the plugin checked out.`;
		if ((await branchCommits(repoPath, branch, base)).length === 0) return `Claude made no commits on ${branch}.`;

		try {
			await pushBranch(repoPath, branch);
			log(`Pushed ${branch} in ${issue.repo}`);
			let pr = pullRequests().find((p) => p.repoPath === repoPath && p.branch === branch);
			if (!pr) {
				const body = epic
					? `${structured.summary}\n\nPart of ${await epicRef(repoPath)}\nResolves #${issue.number}`
					: `${structured.summary}\n\nCloses #${issue.number}`;
				const url = await github.openPullRequest(repoPath, { head: branch, base, title: issue.title, body });
				pr = { repoPath, repo: issue.repo, branch, base, url, state: "open" } satisfies PullRequest;
				pullRequests().push(pr);
				log(`Opened ${url}`);
				update();
			}
			if (epic) {
				// Code reaches a default branch only through a person (BLD-18, BLD-25).
				if (base === defaults.get(repoPath)) throw new Error("A sub-issue's pull request must go into the epic branch.");
				if (pr.state !== "merged") {
					await github.mergePullRequest(repoPath, pr.url);
					pr.state = "merged";
					log(`Merged ${pr.url} into ${base}`);
				}
				// GitHub closes an issue by itself only for a merge into the default branch (BLD-16).
				await github.closeIssue(repoPath, issue.number as number, "completed");
				log(`Closed ${ref(issue)}`);
				await syncEpic(repoPath, base);
			}
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		return null;
	};

	/** BLD-23: after Cancel, keeps or deletes the branch of the issue being built. */
	const afterCancel = async (issue: IssueRecord) => {
		if (issue.build !== "built") {
			issue.build = "failed";
			report.problems.push(plainProblem(`You cancelled the build of ${ref(issue)}.`));
		}
		const branch = issue.branch;
		if (!branch || issue.build === "built" || !(await branchExists(issue.repoPath, branch))) return;
		const choice = await ask({ kind: "cancel", issue: indexOf(issue), branch });
		if (choice !== "delete") return log(`Kept ${branch} in ${issue.repo}`);
		const base = (epic ? build.epicBranches?.find((b) => b.repoPath === issue.repoPath)?.branch : defaults.get(issue.repoPath)) as string;
		try {
			await git(issue.repoPath, ["checkout", "--quiet", base]);
			await git(issue.repoPath, ["branch", "-D", branch]);
			if (await refExists(issue.repoPath, `refs/remotes/origin/${branch}`)) {
				await git(issue.repoPath, ["push", "--quiet", "origin", "--delete", branch], NO_PROMPT_ENV);
			}
			delete issue.branch;
			log(`Deleted ${branch} in ${issue.repo}`);
		} catch (error) {
			report.problems.push(plainProblem(`Couldn't delete ${branch} in ${issue.repo}: ${gitError(error)}`));
		}
	};

	const run = async (): Promise<BuildStatus> => {
		if (epic) {
			// BLD-15: one epic branch name in every repository with a sub-issue, from its default branch, pushed.
			// BLD-27: a continued build reuses this compile's epic branch, so one epic never splits in two.
			const earlier = build.epicBranches ?? [];
			const branch = earlier[0]?.branch ?? (await uniqueBranchName(repos.map((r) => r.path), epicBranchName(epic)));
			const kept = earlier.filter((b) => b.branch === branch && repos.some((r) => r.path === b.repoPath));
			build.epicBranches = [];
			for (const repo of repos) {
				const before = kept.find((b) => b.repoPath === repo.path);
				// A shared report may not know an epic branch's base (REP-50): then it is the default branch.
				const base = before?.base || (defaults.get(repo.path) as string);
				const remote = `refs/remotes/origin/${branch}`;
				try {
					if (await branchExists(repo.path, branch)) {
						log(`Continuing on ${branch} in ${repo.name}`);
					} else if (await refExists(repo.path, remote)) {
						await git(repo.path, ["branch", branch, remote]);
						log(`Continuing on ${branch} in ${repo.name}, from origin`);
					} else {
						await git(repo.path, ["branch", branch, base]);
						log(`Created ${branch} in ${repo.name} from ${base}`);
					}
					if (!(await refExists(repo.path, remote))) {
						await pushBranch(repo.path, branch);
						log(`Pushed ${branch} in ${repo.name}`);
					}
				} catch (error) {
					report.problems.push(plainProblem(`Couldn't create ${branch} in ${repo.name}: ${gitError(error)}`));
					build.epicBranches.push(...kept.filter((b) => !build.epicBranches?.some((e) => e.repoPath === b.repoPath)));
					return "stopped";
				}
				build.epicBranches.push({ repo: repo.name, repoPath: repo.path, branch, base });
			}
		}
		// BLD-16: one at a time, in the plan's order.
		for (const issue of toBuild) {
			for (;;) {
				if (cancelled) {
					await afterCancel(issue);
					return "cancelled";
				}
				issue.build = "building";
				log(`Building ${ref(issue)}: ${issue.title}`);
				const failure = await buildIssue(issue);
				if (failure === "cancelled" || cancelled) {
					await afterCancel(issue);
					return "cancelled";
				}
				if (failure === null) {
					issue.build = "built";
					log(`Built ${ref(issue)}`);
					break;
				}
				issue.build = "failed";
				report.problems.push(plainProblem(`${ref(issue)} failed: ${failure}`));
				const choice = await ask({ kind: "failure", issue: indexOf(issue), reason: failure, canSkip: epic !== null });
				if (cancelled) {
					await afterCancel(issue);
					return "cancelled";
				}
				if (choice === "retry") continue;
				if (choice === "skip" && epic) {
					// The issue stays open and its branch as it is.
					issue.build = "skipped";
					log(`Skipped ${ref(issue)}`);
					break;
				}
				return "stopped";
			}
		}
		if (epic && build.epicBranches?.length) {
			// BLD-28: an epic with skipped sub-issues still finishes. With none built there is nothing to open.
			const [first] = build.epicBranches.filter((b) => b.repoPath === epic.repoPath).concat(build.epicBranches);
			if (issues.some((i) => i.build === "built")) {
				build.message = `Epic #${epic.number} is built on ${first.branch}. Open a pull request into ${first.base} when you're ready.`;
			}
			const stillOpen = issues.filter((i) => i.build === "skipped" && !closed.has(i)).map(ref);
			if (stillOpen.length > 0) build.skippedLine = `Skipped and still open: ${stillOpen.join(", ")}.`;
		}
		return "finished";
	};

	const done = (async () => {
		try {
			build.status = await run();
		} catch (error) {
			report.problems.push(plainProblem(`The build stopped: ${error instanceof Error ? error.message : String(error)}`));
			build.status = "stopped";
		} finally {
			build.finishedAt = new Date().toISOString();
			delete build.waiting;
			await removeSnapshot(snapshot).catch(() => {});
			update();
		}
		return report;
	})();

	return {
		report,
		done,
		requests: () => session?.requests ?? [],
		answer: (id, choice) => session?.answer(id, choice),
		cancel() {
			if (build.status !== "running" || cancelled) return;
			cancelled = true;
			session?.cancel();
			// A failure waiting for Retry, Skip or Stop ends; Cancel then asks about the branch.
			if (build.waiting?.kind === "failure") answerQuestion?.("stop");
		},
		choose(choice) {
			const waiting = build.waiting;
			if (!waiting || !answerQuestion) return;
			const allowed: BuildChoice[] =
				waiting.kind === "cancel" ? ["keep", "delete"] : waiting.canSkip ? ["retry", "skip", "stop"] : ["retry", "stop"];
			if (allowed.includes(choice)) answerQuestion(choice);
		},
	};
}

/** BLD-24: a build cut short by Obsidian closing. The issue being built becomes failed, and its branch stays. */
export function interruptedBuild(report: CompileReport) {
	if (report.build?.status !== "running") return;
	for (const issue of report.issues ?? []) {
		if (issue.build !== "building") continue;
		issue.build = "failed";
		report.problems.push(plainProblem("Obsidian closed before this issue was built."));
	}
	report.build.status = "stopped";
	delete report.build.waiting;
}

/**
 * The repository's newest open compile branch (see Concepts): an issue or epic branch a build made, that still exists,
 * isn't merged into its base and whose pull request isn't merged or closed. Reads only git and the reports.
 */
export async function openBuildBranch(
	repoPath: string,
	reports: CompileReport[],
): Promise<{ branch: string; base: string; pr: PullRequest | null } | null> {
	for (const report of reports) {
		const branches: { branch: string; base: string }[] = (report.build?.epicBranches ?? [])
			.filter((b) => b.repoPath === repoPath)
			.map((b) => ({ branch: b.branch, base: b.base }));
		for (const issue of report.issues ?? []) {
			if (issue.repoPath !== repoPath || !issue.branch) continue;
			const pr = report.pullRequests?.find((p) => p.repoPath === repoPath && p.branch === issue.branch);
			branches.push({ branch: issue.branch, base: pr?.base ?? (await defaultBranch(repoPath)) ?? "main" });
		}
		for (const { branch, base } of branches) {
			if (!(await branchExists(repoPath, branch))) continue;
			const pr = report.pullRequests?.find((p) => p.repoPath === repoPath && p.branch === branch) ?? null;
			if (pr?.state === "merged" || pr?.state === "closed") continue;
			if (await isMerged(repoPath, branch, base)) continue;
			return { branch, base, pr };
		}
	}
	return null;
}

/** A repository whose epic branch has commits and no pull request yet. */
export interface PullRequestCandidate {
	branch: EpicBranch;
	/** Commits on the epic branch that aren't in its base. */
	commits: BranchCommit[];
}

/**
 * The epic branches of this report that still need a pull request (REP-25): only after a build reached the end of
 * an epic, skipped sub-issues or not (BLD-28), and only those with commits and no pull request yet. One issue and each sub-issue get
 * their pull request from the build itself.
 */
export async function pullRequestCandidates(report: CompileReport): Promise<PullRequestCandidate[]> {
	const candidates: PullRequestCandidate[] = [];
	if (report.build?.status !== "finished") return candidates;
	for (const branch of report.build.epicBranches ?? []) {
		if (report.pullRequests?.some((p) => p.repoPath === branch.repoPath && p.branch === branch.branch)) continue;
		if (!(await branchExists(branch.repoPath, branch.branch))) continue;
		const commits = await branchCommits(branch.repoPath, branch.branch, branch.base);
		if (commits.length > 0) candidates.push({ branch, commits });
	}
	return candidates;
}

/**
 * How text written in the repository GitHub names `fromRepoName` refers to an issue or pull request in `repoName`
 * (BLD-26): `#n` in the same repository, `owner/name#n` in another. Repositories are the same only when their GitHub
 * names match, never by local path. When the target's GitHub name is unknown, its web address is used, because a
 * bare `#n` would link to the wrong repository.
 */
export function issueRef(number: number, repoName: string | null, fromRepoName: string | null, url?: string): string {
	if (repoName && fromRepoName && repoName.toLowerCase() === fromRepoName.toLowerCase()) return `#${number}`;
	if (repoName) return `${repoName}#${number}`;
	return url ?? `#${number}`;
}

/**
 * The epic branch pull request's default body in one repository (REP-27): "Closes #{epic}" in the epic's own
 * repository, "Part of {owner}/{name}#{epic}" in the others. Both are GitHub names (`owner/name`), so "the epic's own
 * repository" is decided by comparing them.
 */
export function epicPullRequestBody(report: CompileReport, repoName: string | null, epicRepoName: string | null): string {
	const epic = report.issues?.find((i) => i.kind === "epic");
	if (!epic?.number) return "";
	const ref = issueRef(epic.number, epicRepoName, repoName, epic.url);
	return ref === `#${epic.number}` ? `Closes ${ref}` : `Part of ${ref}`;
}

/** The shared Body's default on the Create PR page (REP-27): "Part of {owner}/{name}#{epic}", whatever the repository. */
export function sharedEpicPullRequestBody(report: CompileReport, epicRepoName: string | null): string {
	const epic = report.issues?.find((i) => i.kind === "epic");
	if (!epic?.number) return "";
	return `Part of ${issueRef(epic.number, epicRepoName, null, epic.url)}`;
}

