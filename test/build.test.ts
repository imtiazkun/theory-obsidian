import { join } from "path";
import { describe, expect, it } from "vitest";
import { SAME, defaultTaskRows, taskAgentSettings } from "../src/agent-rows";
import { uniqueBranchName } from "../src/branches";
import {
	BuildChoice,
	BuildOptions,
	buildPromptText,
	buildableReport,
	epicBranchName,
	epicPullRequestBody,
	interruptedBuild,
	issueBranchName,
	openBuildBranch,
	pullRequestCandidates,
	startBuild,
} from "../src/build";
import { COMPILED_TAG, CompileReport, GH_LOGIN, NO_PROJECT } from "../src/compile";
import type { IssueRecord } from "../src/plan";
import { FakeGitHub } from "./fake-github";
import { FakeStep, fakeClaude, repoWithOrigin } from "./fake-claude";
import { commitFiles, initRepo, out, tempFolder, write } from "./helpers";

const PROJECT_URL = "https://github.com/orgs/team/projects/1";
const built = (summary = "Built it.") => ({ status: "succeeded", summary, changes: ["Changed a thing"], questions: [], problems: [] });
const failed = { status: "failed", summary: "The tests fail.", changes: [], questions: [], problems: [] };

/** A vault, and a project folder with `api` and `web`, each with a bare `origin`. */
async function setup() {
	const root = tempFolder();
	const vault = join(root, "vault");
	const project = join(root, "project");
	await initRepo(vault, { "Note.md": "# Note\n\nThe rule.\n" });
	const api = await repoWithOrigin(project, "api");
	const web = await repoWithOrigin(project, "web");
	const github = new FakeGitHub();
	const claude = fakeClaude([{ commit: "built.txt", answer: built() }]);
	const options = (extra: Partial<BuildOptions> = {}): BuildOptions => ({
		vaultPath: vault,
		projectFolder: project,
		claudeCommand: claude.command,
		agent: "claude",
		permissionMode: "acceptEdits",
		allowedTools: "",
		model: "",
		effort: "",
		githubProject: PROJECT_URL,
		github,
		...extra,
	});
	return { root, vault, project, api, web, github, claude, options };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** A succeeded compile's report whose issues exist on the fake GitHub, the epic first. */
async function planned(s: Setup, issues: { repo: string; shortName: string }[], epic = false): Promise<CompileReport> {
	const records: IssueRecord[] = [];
	const add = async (kind: IssueRecord["kind"], repo: string, shortName: string, title: string) => {
		const repoPath = join(s.project, repo);
		const created = await s.github.createIssue(repoPath, { title, body: "", labels: kind === "epic" ? ["epic"] : [] });
		records.push({ kind, repo, repoPath, title, body: `Build ${shortName}.`, rules: ["R-1"], shortName, ...created, inProject: true, linked: true });
	};
	if (epic) await add("epic", "api", "big-thing", "Ship the big thing");
	for (const issue of issues) await add("issue", issue.repo, issue.shortName, `Change ${issue.shortName}`);
	return {
		id: "1",
		status: "succeeded",
		startedAt: new Date().toISOString(),
		fromCommit: null,
		toCommit: await out(s.vault, ["rev-parse", "HEAD"]),
		revisions: [],
		summary: "Planned.",
		changes: [],
		questions: [],
		problems: [],
		log: [],
		issues: records,
	};
}

/** Runs a build to the end, answering each question with `answer`, and calling `onUpdate` on every change. */
async function build(
	s: Setup,
	report: CompileReport,
	options: { answer?: (report: CompileReport) => BuildChoice; reports?: CompileReport[]; onUpdate?: (report: CompileReport, cancel: () => void) => void } = {},
) {
	let run: Awaited<ReturnType<typeof startBuild>>;
	let answering = false;
	run = await startBuild(s.options(), report, options.reports ?? [report], (r) => {
		options.onUpdate?.(r, () => run.cancel());
		if (r.build?.waiting && !answering && options.answer) {
			answering = true;
			const choice = options.answer(r);
			setTimeout(() => {
				answering = false;
				run.choose(choice);
			}, 0);
		}
	});
	await run.done;
	return report;
}

const branches = async (repo: string) => (await out(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"])).split("\n").filter(Boolean);
const remoteHead = (bare: string, branch: string) => out(bare, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).catch(() => null);

describe("the checks before a build (BLD-5 to BLD-9)", () => {
	it("stops when Claude Code isn't found, gh isn't logged in, or the GitHub Project isn't set", async () => {
		const s = await setup();
		const report = await planned(s, [{ repo: "api", shortName: "one" }]);
		await expect(startBuild(s.options({ claudeCommand: "theory-no-such-claude" }), report, [report], () => {})).rejects.toThrow(
			`Couldn't find the Claude Code CLI ("theory-no-such-claude"). Set its path in theory.md settings.`,
		);
		s.github.loggedIn = false;
		await expect(startBuild(s.options(), report, [report], () => {})).rejects.toThrow(GH_LOGIN);
		s.github.loggedIn = true;
		await expect(startBuild(s.options({ githubProject: "" }), report, [report], () => {})).rejects.toThrow(NO_PROJECT);
		s.github.projectError = "HTTP 404";
		await expect(startBuild(s.options(), report, [report], () => {})).rejects.toThrow(`Couldn't reach the GitHub Project ${PROJECT_URL}: HTTP 404`);
		expect(report.build).toBeUndefined();
		expect(s.claude.calls()).toEqual([]);
	});

	it("stops when Build's row is an ACP agent with no command, even when Compile's row is Claude Code (AGT-5, BLD-19)", async () => {
		const s = await setup();
		const report = await planned(s, [{ repo: "api", shortName: "one" }]);
		const tasks = defaultTaskRows();
		tasks.compile.agentCommand = "compile-agent --acp";
		tasks.build = { agent: "acp", agentCommand: "", agentModel: "m", agentThinkingLevel: "", model: SAME, effort: SAME };
		const agent = taskAgentSettings({ tasks, claudeCommand: s.claude.command, permissionMode: "acceptEdits", allowedTools: "" }, "build");
		expect(agent.agent).toBe("acp");
		await expect(startBuild(s.options(agent), report, [report], () => {})).rejects.toThrow(
			"Set the agent command in theory.md settings first.",
		);
		expect(report.build).toBeUndefined();
		expect(s.claude.calls()).toEqual([]);
		expect(await branches(s.api.repo)).toEqual(["main"]);
	});

	it("stops on uncommitted changes in a repository with an issue, and only there", async () => {
		const s = await setup();
		const report = await planned(s, [{ repo: "api", shortName: "one" }]);
		write(s.api.repo, { "wip.ts": "wip\n" });
		await expect(startBuild(s.options(), report, [report], () => {})).rejects.toThrow(
			"These repositories have uncommitted changes: api. Commit or stash them first.",
		);
		await commitFiles(s.api.repo, {}, "Keep wip");
		write(s.web.repo, { "wip.ts": "wip\n" });
		await build(s, report);
		expect(report.issues?.[0].build).toBe("built");
	});

	it("fast-forwards a default branch that is only behind, and stops when it has commits of its own too", async () => {
		const s = await setup();
		const other = join(s.root, "other");
		await out(s.root, ["clone", "--quiet", s.api.bare, other]);
		const theirs = await commitFiles(other, { "theirs.txt": "theirs\n" }, "Theirs");
		await out(other, ["push", "--quiet", "origin", "main"]);
		await out(s.api.repo, ["fetch", "--quiet"]);
		const report = await planned(s, [{ repo: "api", shortName: "one" }]);
		await build(s, report);
		expect(await out(s.api.repo, ["rev-parse", "main"])).toBe(theirs);
		expect(await out(s.api.repo, ["merge-base", "--is-ancestor", theirs, "theory/1-one"]).then(() => true)).toBe(true);

		const s2 = await setup();
		const other2 = join(s2.root, "other");
		await out(s2.root, ["clone", "--quiet", s2.api.bare, other2]);
		await commitFiles(other2, { "theirs.txt": "theirs\n" }, "Theirs");
		await out(other2, ["push", "--quiet", "origin", "main"]);
		await out(s2.api.repo, ["fetch", "--quiet"]);
		await commitFiles(s2.api.repo, { "mine.txt": "mine\n" }, "Mine");
		const report2 = await planned(s2, [{ repo: "api", shortName: "one" }]);
		await expect(startBuild(s2.options(), report2, [report2], () => {})).rejects.toThrow(
			"main in api and origin/main both have new commits. Pull with rebase in git, then build again.",
		);
	});

	it("stops while an earlier build left an open pull request or an open epic branch", async () => {
		const s = await setup();
		const earlier = await planned(s, [{ repo: "api", shortName: "one" }]);
		await build(s, earlier);
		const pr = earlier.pullRequests?.[0].url as string;
		const report = { ...(await planned(s, [{ repo: "api", shortName: "two" }])), id: "2" };
		await expect(startBuild(s.options(), report, [report, earlier], () => {})).rejects.toThrow(`Finish the open work in api first: ${pr}.`);
		// Once GitHub says it is merged, it no longer counts.
		s.github.pullRequests[0].state = "merged";
		s.claude.setSteps([
			{ commit: "a.txt", answer: built() },
			{ commit: "b.txt", answer: built() },
		]);
		const epicReport = { ...(await planned(s, [{ repo: "web", shortName: "a" }, { repo: "web", shortName: "b" }], true)), id: "3" };
		await build(s, epicReport, { reports: [epicReport, earlier] });
		const epicBranch = epicReport.build?.epicBranches?.[0].branch;
		const next = { ...(await planned(s, [{ repo: "web", shortName: "c" }])), id: "4" };
		await expect(startBuild(s.options(), next, [next, epicReport, earlier], () => {})).rejects.toThrow(
			`Finish the open work in web first: ${epicBranch}.`,
		);
	});

	it("skips a closed issue and says so", async () => {
		const s = await setup();
		const report = await planned(s, [{ repo: "api", shortName: "one" }]);
		s.github.issues[0].state = "closed";
		await build(s, report);
		expect(report.issues?.[0].build).toBe("skipped");
		expect(report.problems.map((p) => p.text)).toContain("Skipped api#1: the issue is closed.");
		expect(s.claude.calls()).toEqual([]);
	});
});

describe("build branches (BLD-10 to BLD-12)", () => {
	it("names issue and epic branches from the number and the short name", () => {
		expect(issueBranchName({ number: 57, shortName: "sparkle-long-folders" })).toBe("theory/57-sparkle-long-folders");
		expect(epicBranchName({ number: 12, shortName: "big-thing" })).toBe("theory/epic-12-big-thing");
	});

	it("adds -2, -3 when the name is taken here or on origin, and gives an epic one name in every repository", async () => {
		const s = await setup();
		expect(await uniqueBranchName([s.api.repo], "theory/1-one")).toBe("theory/1-one");
		await out(s.api.repo, ["branch", "theory/1-one"]);
		expect(await uniqueBranchName([s.api.repo], "theory/1-one")).toBe("theory/1-one-2");
		await out(s.api.repo, ["branch", "theory/1-one-2"]);
		await out(s.api.repo, ["push", "--quiet", "origin", "theory/1-one-2:theory/1-one-3"]);
		await out(s.api.repo, ["fetch", "--quiet"]);
		expect(await uniqueBranchName([s.api.repo], "theory/1-one")).toBe("theory/1-one-4");
		// Taken in web only: both repositories get -2.
		await out(s.web.repo, ["branch", "theory/epic-1-big-thing"]);
		expect(await uniqueBranchName([s.api.repo, s.web.repo], "theory/epic-1-big-thing")).toBe("theory/epic-1-big-thing-2");
	});

	it("never reuses a taken name when building", async () => {
		const s = await setup();
		const report = await planned(s, [{ repo: "api", shortName: "one" }]);
		await out(s.api.repo, ["branch", "theory/1-one"]);
		await build(s, report);
		expect(report.issues?.[0].branch).toBe("theory/1-one-2");
		expect(await out(s.api.repo, ["rev-parse", "theory/1-one"])).toBe(await out(s.api.repo, ["rev-parse", "main"]));
	});
});

describe("building one issue (BLD-13, BLD-14)", () => {
	it("builds on a branch from the default branch, pushes it, and opens a pull request into the default branch that closes the issue", async () => {
		const s = await setup();
		const report = await planned(s, [{ repo: "api", shortName: "one" }]);
		expect(buildPromptText(report)).toBe("1 issue is ready. Build it now?");
		const mainBefore = await out(s.api.repo, ["rev-parse", "main"]);
		await build(s, report);

		const [issue] = report.issues ?? [];
		expect(issue.build).toBe("built");
		expect(issue.branch).toBe("theory/1-one");
		expect(report.build?.status).toBe("finished");
		const [call] = s.claude.calls();
		expect(call.cwd).toBe(s.api.repo);
		expect(call.prompt).toContain("Issue: #1");
		expect(call.prompt).toContain("Branch checked out: theory/1-one");
		expect(call.prompt).toContain("`Refs #1`");
		expect(await out(s.api.repo, ["merge-base", "--is-ancestor", mainBefore, "theory/1-one"]).then(() => true)).toBe(true);
		expect(await remoteHead(s.api.bare, "theory/1-one")).toBe(await out(s.api.repo, ["rev-parse", "theory/1-one"]));
		expect(s.github.pullRequests.map((p) => [p.repo, p.head, p.base, p.title, p.body])).toEqual([
			["api", "theory/1-one", "main", "Change one", "Built it.\n\nCloses #1"],
		]);
		expect(report.pullRequests?.map((p) => [p.branch, p.base, p.state])).toEqual([["theory/1-one", "main", "open"]]);
		// The engineer merges it: the issue stays open and main doesn't move.
		expect(s.github.issues[0].state).toBe("open");
		expect(await remoteHead(s.api.bare, "main")).toBe(mainBefore);
		expect(await out(s.vault, ["tag", "--list", COMPILED_TAG])).toBe("");
	});
});

describe("building an epic (BLD-15, BLD-16, BLD-25)", () => {
	it("builds sub-issues in order on branches from the epic branch, merges each into it, closes each, and never touches a default branch", async () => {
		const s = await setup();
		s.claude.setSteps([
			{ commit: "first.txt", answer: built("First.") },
			{ commit: "second.txt", answer: built("Second.") },
			{ commit: "third.txt", answer: built("Third.") },
		]);
		const report = await planned(
			s,
			[
				{ repo: "web", shortName: "first" },
				{ repo: "api", shortName: "second" },
				{ repo: "web", shortName: "third" },
			],
			true,
		);
		const mains = [await remoteHead(s.api.bare, "main"), await remoteHead(s.web.bare, "main")];
		await build(s, report);

		const epicBranch = "theory/epic-1-big-thing";
		expect(report.build?.epicBranches?.map((b) => [b.repo, b.branch, b.base])).toEqual([
			["web", epicBranch, "main"],
			["api", epicBranch, "main"],
		]);
		expect(s.claude.calls().map((c) => c.cwd)).toEqual([s.web.repo, s.api.repo, s.web.repo]);
		expect(report.issues?.slice(1).map((i) => [i.branch, i.build])).toEqual([
			["theory/2-first", "built"],
			["theory/3-second", "built"],
			["theory/4-third", "built"],
		]);
		expect(s.github.pullRequests.map((p) => [p.repo, p.head, p.base, p.state, p.body])).toEqual([
			["web", "theory/2-first", epicBranch, "merged", "First.\n\nPart of team/api#1\nResolves #2"],
			["api", "theory/3-second", epicBranch, "merged", "Second.\n\nPart of #1\nResolves #3"],
			["web", "theory/4-third", epicBranch, "merged", "Third.\n\nPart of team/api#1\nResolves #4"],
		]);
		expect(s.github.calls.filter((c) => c.startsWith("mergePullRequest")).length).toBe(3);
		expect(s.github.issues.map((i) => [i.number, i.state, i.closedAs ?? null])).toEqual([
			[1, "open", null],
			[2, "closed", "completed"],
			[3, "closed", "completed"],
			[4, "closed", "completed"],
		]);
		// The third sub-issue was built on top of the first.
		expect((await out(s.web.bare, ["ls-tree", "--name-only", epicBranch])).split("\n")).toEqual(["README.md", "first.txt", "third.txt"]);
		expect((await out(s.api.bare, ["ls-tree", "--name-only", epicBranch])).split("\n")).toEqual(["README.md", "second.txt"]);
		// Nothing reached a default branch.
		expect([await remoteHead(s.api.bare, "main"), await remoteHead(s.web.bare, "main")]).toEqual(mains);
		expect(report.build?.message).toBe(`Epic #1 is built on ${epicBranch}. Open a pull request into main when you're ready.`);
		expect(await out(s.vault, ["tag", "--list", COMPILED_TAG])).toBe("");
	});
});

describe("the epic's pull requests and open branches (REP-25, REP-27, REPO)", () => {
	it("offers Create PR for each epic branch once every sub-issue is built, with the epic's title and bodies", async () => {
		const s = await setup();
		s.claude.setSteps([
			{ commit: "a.txt", answer: built() },
			{ commit: "b.txt", answer: built() },
		]);
		const report = await planned(s, [{ repo: "web", shortName: "a" }, { repo: "api", shortName: "b" }], true);
		expect(await pullRequestCandidates(report)).toEqual([]);
		await build(s, report);
		const candidates = await pullRequestCandidates(report);
		expect(candidates.map((c) => [c.branch.repo, c.branch.branch, c.branch.base, c.commits.length > 0])).toEqual([
			["web", "theory/epic-1-big-thing", "main", true],
			["api", "theory/epic-1-big-thing", "main", true],
		]);
		expect(epicPullRequestBody(report, s.api.repo, "team/api")).toBe("Closes #1");
		expect(epicPullRequestBody(report, s.web.repo, "team/api")).toBe("Part of team/api#1");
		// A single issue's pull request comes from the build itself.
		const single = { ...(await planned(s, [{ repo: "api", shortName: "c" }])), id: "2" };
		single.build = { status: "finished", startedAt: "" };
		expect(await pullRequestCandidates(single)).toEqual([]);
	});

	it("finds the repository's open build branch until its pull request is merged or closed", async () => {
		const s = await setup();
		const report = await planned(s, [{ repo: "api", shortName: "one" }]);
		await build(s, report);
		expect(await openBuildBranch(s.api.repo, [report])).toMatchObject({ branch: "theory/1-one", base: "main", pr: { state: "open" } });
		expect(await openBuildBranch(s.web.repo, [report])).toBeNull();
		(report.pullRequests ?? [])[0].state = "closed";
		expect(await openBuildBranch(s.api.repo, [report])).toBeNull();
	});
});

describe("when a build goes wrong (BLD-22, BLD-23)", () => {
	const twoSubs = (s: Setup) =>
		planned(
			s,
			[
				{ repo: "api", shortName: "first" },
				{ repo: "api", shortName: "second" },
			],
			true,
		);

	it("Retry builds the issue again on the same branch", async () => {
		const s = await setup();
		s.claude.setSteps([{ answer: failed }, { commit: "built.txt", answer: built() }]);
		const report = await planned(s, [{ repo: "api", shortName: "one" }]);
		const asked: unknown[] = [];
		await build(s, report, {
			answer: (r) => {
				asked.push({ ...r.build?.waiting });
				return "retry";
			},
		});
		// A single issue has no Skip.
		expect(asked).toEqual([{ kind: "failure", issue: 0, reason: "Claude reported failed: The tests fail.", canSkip: false }]);
		expect(report.issues?.[0]).toMatchObject({ build: "built", branch: "theory/1-one" });
		expect(await branches(s.api.repo)).toEqual(["main", "theory/1-one"]);
		expect(s.github.pullRequests).toHaveLength(1);
	});

	it("Skip leaves a sub-issue open with its branch, and goes on to the next", async () => {
		const s = await setup();
		s.claude.setSteps([{ answer: failed }, { commit: "second.txt", answer: built() }]);
		const report = await twoSubs(s);
		await build(s, report, { answer: () => "skip" });
		expect(report.issues?.slice(1).map((i) => i.build)).toEqual(["skipped", "built"]);
		expect(s.github.issues.map((i) => i.state)).toEqual(["open", "open", "closed"]);
		expect(await branches(s.api.repo)).toContain("theory/2-first");
		expect(report.build?.status).toBe("finished");
	});

	it("Stop ends the build, and the issues not built stay open", async () => {
		const s = await setup();
		s.claude.setSteps([{ answer: failed }]);
		const report = await twoSubs(s);
		await build(s, report, { answer: () => "stop" });
		expect(report.build?.status).toBe("stopped");
		expect(report.issues?.slice(1).map((i) => i.build)).toEqual(["failed", "waiting"]);
		expect(s.github.issues.map((i) => i.state)).toEqual(["open", "open", "open"]);
		expect(s.claude.calls()).toHaveLength(1);
		expect(report.build?.message).toBeUndefined();
	});

	it("fails an issue Claude made no commits for, or whose branch Claude switched away from", async () => {
		const s = await setup();
		s.claude.setSteps([{ answer: built() }, { checkout: "elsewhere", commit: "x.txt", answer: built() }]);
		const report = await twoSubs(s);
		const reasons: string[] = [];
		await build(s, report, {
			answer: (r) => {
				reasons.push(r.build?.waiting?.kind === "failure" ? r.build.waiting.reason : "");
				return "skip";
			},
		});
		expect(reasons).toEqual([
			"Claude made no commits on theory/2-first.",
			"Claude switched away from theory/3-second. Claude must commit on the branch the plugin checked out.",
		]);
		expect(s.github.pullRequests).toEqual([]);
	});

	for (const choice of ["keep", "delete"] as const) {
		it(`Cancel stops Claude, then ${choice === "keep" ? "keeps" : "deletes"} the issue's branch, and the issues not built stay open`, async () => {
			const s = await setup();
			s.claude.setSteps([{ hang: true }]);
			const report = await twoSubs(s);
			let cancel: (() => void) | null = null;
			// Cancel once Claude is running on the first sub-issue.
			const poll = setInterval(() => {
				if (cancel && s.claude.calls().length > 0) {
					clearInterval(poll);
					cancel();
				}
			}, 50);
			await build(s, report, {
				onUpdate: (_r, c) => (cancel ??= c),
				answer: (r) => {
					expect(r.build?.waiting).toEqual({ kind: "cancel", issue: 1, branch: "theory/2-first" });
					return choice;
				},
			});
			clearInterval(poll);
			expect(report.build?.status).toBe("cancelled");
			expect(report.issues?.slice(1).map((i) => i.build)).toEqual(["failed", "waiting"]);
			expect(s.github.issues.every((i) => i.state === "open")).toBe(true);
			expect((await branches(s.api.repo)).includes("theory/2-first")).toBe(choice === "keep");
		});
	}
});

describe("a build after Obsidian closed, and which compile Build builds (BLD-1, BLD-24)", () => {
	it("marks the issue being built as failed, and keeps its branch", () => {
		const report = {
			problems: [],
			issues: [{ kind: "issue", build: "built" }, { kind: "issue", build: "building", branch: "theory/2-x" }, { kind: "issue", build: "waiting" }],
			build: { status: "running", startedAt: "", waiting: { kind: "failure", issue: 1, reason: "", canSkip: true } },
		} as unknown as CompileReport;
		interruptedBuild(report);
		expect(report.issues?.map((i) => i.build)).toEqual(["built", "failed", "waiting"]);
		expect(report.issues?.[1].branch).toBe("theory/2-x");
		expect(report.problems.map((p) => p.text)).toEqual(["Obsidian closed before this issue was built."]);
		expect(report.build?.status).toBe("stopped");
		expect(report.build?.waiting).toBeUndefined();
	});

	it("builds the newest compile that created issues", () => {
		const withIssues = (id: string, status: CompileReport["status"], issues: Partial<IssueRecord>[]) =>
			({ id, status, issues }) as unknown as CompileReport;
		const reports = [
			withIssues("3", "failed", []),
			withIssues("2", "succeeded", [{ kind: "issue", number: 4 }]),
			withIssues("1", "succeeded", [{ kind: "issue", number: 1 }]),
		];
		expect(buildableReport(reports)?.id).toBe("2");
		expect(buildableReport([withIssues("1", "succeeded", [])])).toBeNull();
	});
});
