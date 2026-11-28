import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CODE_SNAPSHOT_CHANGED,
	CompileOptions,
	CompileReport,
	GH_LOGIN,
	NO_PROJECT,
	READ_ONLY_TOOLS,
	claudeArgs,
	compilePrompt,
	pendingRevisionCount,
	startCompile,
} from "../src/compile";
import { IssueRecord, PLAN_SCHEMA, canDiscard, compileFinishedText, epicRepo, issueBody, readPlan, readyText, shortNameProblem, stepsLeft, titleProblem } from "../src/plan";
import { compileEndDetails, compileStartDetails } from "../src/hooks";
import {
	COMMIT_ANSWERS_FIRST,
	buildBranch,
	failedPrefix,
	issueFate,
	issueOrigin,
	recompileBlocker,
	recompileButton,
	recompiledBy,
	recompiledReport,
	startFailure,
} from "../src/recompile";
import { IdentityError, git } from "../src/vault";
import { FakeGitHub } from "./fake-github";
import { fakeClaude } from "./fake-claude";
import { commitFiles, initRepo, markCompiled, out, tempFolder, write } from "./helpers";
import { compileMoment, fromSharedReport, markerCommit, shareReport } from "../src/shared-report";
import { pushVault } from "../src/push";

const PROJECT_URL = "https://github.com/orgs/team/projects/1";

const issue = (repo: string, shortName: string, title = `Change ${shortName}`) => ({
	repo,
	title,
	body: `Build ${shortName}.`,
	rules: ["R-1"],
	shortName,
});
const epic = { title: "Ship the big thing", body: "Several pieces.", rules: ["R-1", "R-2"], shortName: "big-thing" };
const answer = (plan: unknown, status = "succeeded") => ({ status, summary: "Planned.", plan, questions: [], problems: [] });

/** A vault with one pending revision, and a project folder holding `repos`, each committed and clean. */
async function setup(repos = ["api", "web"]) {
	const root = tempFolder();
	const vault = join(root, "vault");
	const project = join(root, "project");
	await initRepo(vault, { "Note.md": "# Note\n\nThe rule.\n" });
	for (const repo of repos) await initRepo(join(project, repo));
	const github = new FakeGitHub();
	const claude = fakeClaude([{ answer: answer({ issues: [issue("api", "one")] }) }]);
	const options = (extra: Partial<CompileOptions> = {}): CompileOptions => ({
		// Each compile Claude ran is shared and committed, as the plugin does (REP-46).
		share: async (report, snapshots) => {
			const moment = compileMoment(report);
			if (!moment) return;
			const reports = [report, ...(extra.reports ?? [])];
			await shareReport({ vaultPath: vault, reports, logPaths: { projectFolder: project, ...snapshots }, push: () => pushVault(vault) }, report, moment);
		},
		vaultPath: vault,
		projectFolder: project,
		claudeCommand: claude.command,
		agent: "claude",
		permissionMode: "acceptEdits",
		allowedTools: "Bash(git *)",
		model: "",
		effort: "",
		author: "Test Author",
		githubProject: PROJECT_URL,
		github,
		...extra,
	});
	// "moved" once a committed shared report moved the marker (REP-49).
	const marker = async () => ((await markerCommit(vault)) === null ? "" : "moved");
	return { root, vault, project, github, claude, options, marker };
}

/** Runs a compile to the end, answering CMP-68's question with `choices` in turn. */
async function compile(options: CompileOptions, choices: ("retry" | "discard")[] = []): Promise<CompileReport> {
	let run: Awaited<ReturnType<typeof startCompile>>;
	let asked = false;
	run = await startCompile(options, (report) => {
		if (report.issueFailure && !asked) {
			asked = true;
			const choice = choices.shift();
			setTimeout(() => {
				asked = false;
				if (choice === "retry") run.retryIssues();
				else run.discardIssues();
			}, 0);
		}
	});
	return run.done;
}

describe("the checks before a compile (CMP-36, CMP-55 to CMP-57)", () => {
	it("stops on uncommitted changes in a repository, first of these checks, and the marker stays", async () => {
		const s = await setup();
		write(join(s.project, "web"), { "wip.ts": "wip\n" });
		s.github.loggedIn = false;
		await expect(startCompile(s.options(), () => {})).rejects.toThrow(
			"These repositories have uncommitted changes: web. Commit or stash them first.",
		);
		expect(s.github.calls).toEqual([]);
		expect(await s.marker()).toBe("");
	});

	it("stops when gh isn't logged in, before it looks at the origins", async () => {
		const s = await setup();
		s.github.loggedIn = false;
		s.github.noOrigin.add("web");
		await expect(startCompile(s.options(), () => {})).rejects.toThrow(GH_LOGIN);
		expect(GH_LOGIN).toBe("Log in to GitHub first. Run gh auth login in a terminal.");
		expect(await s.marker()).toBe("");
	});

	it("stops when a repository has no GitHub origin, before it looks at the project", async () => {
		const s = await setup();
		s.github.noOrigin.add("api");
		s.github.noOrigin.add("web");
		await expect(startCompile(s.options({ githubProject: "" }), () => {})).rejects.toThrow(
			"These repositories have no GitHub origin: api, web.",
		);
		expect(await s.marker()).toBe("");
	});

	it("stops without a GitHub Project, or when gh can't reach it", async () => {
		const s = await setup();
		await expect(startCompile(s.options({ githubProject: "  " }), () => {})).rejects.toThrow(NO_PROJECT);
		expect(NO_PROJECT).toBe("Choose the GitHub Project in theory.md settings first.");
		s.github.projectError = "HTTP 404";
		await expect(startCompile(s.options(), () => {})).rejects.toThrow(`Couldn't reach the GitHub Project ${PROJECT_URL}: HTTP 404`);
		expect(s.claude.calls()).toEqual([]);
		expect(await s.marker()).toBe("");
	});
});

describe("a read-only compile (CMP-13, CMP-69)", () => {
	it("gives Claude Code only the tools that read, and denies the rest without asking", () => {
		const args = claudeArgs({
			settings: { claudeCommand: "claude", permissionMode: "bypassPermissions", allowedTools: "Bash(npm test)", model: "", effort: "" },
			protectedPaths: ["/vault", "/snapshot"],
			snapshot: "/snapshot",
			schema: { required: [] },
			readOnly: true,
		});
		const after = (flag: string) => args[args.indexOf(flag) + 1];
		expect(after("--tools")).toBe(READ_ONLY_TOOLS.join(","));
		expect(READ_ONLY_TOOLS).toEqual(["Read", "Glob", "Grep"]);
		expect(after("--permission-mode")).toBe("dontAsk");
		expect(after("--allowedTools")).toBe("Read Glob Grep");
		expect(args).not.toContain("Bash(npm test)");
		const denied = args.slice(args.indexOf("--disallowedTools") + 1);
		for (const tool of ["Edit", "Write", "NotebookEdit", "MultiEdit", "Bash"]) expect(denied).toContain(tool);

		// A build keeps the engineer's permission mode and allowed commands.
		const build = claudeArgs({
			settings: { claudeCommand: "claude", permissionMode: "acceptEdits", allowedTools: "Bash(npm test)", model: "", effort: "" },
			protectedPaths: [],
			snapshot: "/snapshot",
			schema: { required: [] },
			readOnly: false,
		});
		expect(build).not.toContain("--tools");
		expect(build[build.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
		expect(build[build.indexOf("--allowedTools") + 1]).toBe("Bash(npm test)");
	});

	it("leaves every code repository as it was: no file, commit, branch or push", async () => {
		const s = await setup();
		const state = async () =>
			Promise.all(
				["api", "web"].map(async (repo) => [
					await out(join(s.project, repo), ["for-each-ref", "--format=%(refname) %(objectname)"]),
					await out(join(s.project, repo), ["symbolic-ref", "HEAD"]),
					await out(join(s.project, repo), ["status", "--porcelain", "--untracked-files=all"]),
				]),
			);
		const before = await state();
		const report = await compile(s.options());
		expect(report.status).toBe("succeeded");
		expect(await state()).toEqual(before);
		const [call] = s.claude.calls();
		// Claude runs in the code snapshot, never in the project folder (CMP-13, CMP-84).
		expect(call.cwd).not.toBe(s.project);
		expect(basename(call.cwd)).toMatch(/^theory-code-/);
		expect(call.args[call.args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
		expect(call.prompt).toContain("Read the code only in the code snapshot. It is each repository's default branch as `origin` has it.");
		expect(call.prompt).toContain("Never change a file anywhere");
		expect(call.prompt).toContain("Never create issues, branches or pull requests, and never touch GitHub.");
	});
});

describe("the code snapshot (CMP-84 to CMP-89, INV-14)", () => {
	// Each test gets its own temp folder for snapshots, so it can see that every one was deleted (CMP-89).
	let temp: string | undefined;
	let saved: string | undefined;
	beforeEach(() => {
		saved = process.env.TMPDIR;
		temp = tempFolder();
		process.env.TMPDIR = temp;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = saved;
	});
	const codeSnapshots = () => readdirSync(temp as string).filter((name) => name.startsWith("theory-code-"));

	/** Gives the repository a bare `origin` holding its main, as a clone would have it. Returns a second clone to push from. */
	async function addOrigin(root: string, repo: string): Promise<string> {
		const name = basename(repo);
		const bare = join(root, `${name}.git`);
		await git(root, ["init", "--bare", "-b", "main", bare]);
		await git(repo, ["remote", "add", "origin", bare]);
		await git(repo, ["push", "--quiet", "-u", "origin", "main"]);
		await git(repo, ["remote", "set-head", "origin", "main"]);
		const teammate = join(root, `${name}-teammate`);
		await git(root, ["clone", "--quiet", bare, teammate]);
		return teammate;
	}

	/** Everything in a repository a compile must never change (CMP-85): refs, HEAD, working tree, stashes and config. */
	const repoState = async (repo: string) => [
		await out(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]),
		await out(repo, ["symbolic-ref", "-q", "HEAD"]).catch(() => "detached"),
		await out(repo, ["status", "--porcelain", "--untracked-files=all", "--ignored"]),
		await out(repo, ["stash", "list"]),
		readFileSync(join(repo, ".git", "config"), "utf8"),
	];

	it("holds origin's default branch: not the checkout, an unpushed commit or an ignored file, and the agent runs in it", async () => {
		const s = await setup(["api"]);
		s.claude.setSteps([{ listFiles: true, answer: answer({ issues: [issue("api", "one")] }) }]);
		const api = join(s.project, "api");
		const teammate = await addOrigin(s.root, api);
		// The team merged more; the pull before the compile fetched it, but the checkout can't fast-forward.
		const merged = await commitFiles(teammate, { "merged.ts": "merged\n" }, "Merged work");
		await git(teammate, ["push", "--quiet", "origin", "main"]);
		await commitFiles(api, { "unpushed.ts": "mine\n" }, "Not pushed");
		await git(api, ["fetch", "--quiet"]);
		// The checkout sits on an old compile branch, with an ignored file the engineer keeps.
		await git(api, ["checkout", "--quiet", "-b", "theory/1-old"]);
		await commitFiles(api, { "old.ts": "old\n" }, "Old compile work");
		write(api, { ".gitignore": "secret.env\n" });
		await git(api, ["add", ".gitignore"]);
		await git(api, ["commit", "--quiet", "-m", "Ignore secrets"]);
		write(api, { "secret.env": "KEY=1\n" });
		const before = await repoState(api);

		const report = await compile(s.options({ fetched: [api] }));
		expect(report.status).toBe("succeeded");
		const [call] = s.claude.calls();
		expect(basename(call.cwd)).toMatch(/^theory-code-/);
		expect(call.cwd.startsWith(s.project)).toBe(false);
		expect(call.files).toEqual(["api/README.md", "api/merged.ts"]);
		expect(call.prompt).toContain(`one folder per repository under the same name: ${call.cwd}`);
		expect(call.prompt).toContain(`- api: main at ${merged.slice(0, 7)}\n`);
		// Every write to it is denied (INV-14).
		expect(call.args).toContain(`Write(//${call.cwd.replace(/^\//, "")}/**)`);
		expect(report.code).toEqual([
			{ repo: "api", branch: "main", commit: merged, source: "origin", url: `https://github.com/team/api/commit/${merged}` },
		]);
		// Nothing in the repository changed (CMP-85), and the snapshot is gone (CMP-89).
		expect(await repoState(api)).toEqual(before);
		expect(codeSnapshots()).toEqual([]);
	});

	it("uses the branch GitHub names as the default", async () => {
		const s = await setup(["api"]);
		s.claude.setSteps([{ listFiles: true, answer: answer({ issues: [issue("api", "one")] }) }]);
		const api = join(s.project, "api");
		const teammate = await addOrigin(s.root, api);
		await git(teammate, ["checkout", "--quiet", "-b", "trunk"]);
		const trunk = await commitFiles(teammate, { "trunk.ts": "trunk\n" }, "Trunk work");
		await git(teammate, ["push", "--quiet", "origin", "trunk"]);
		await git(api, ["fetch", "--quiet"]);
		s.github.defaultBranches.set("api", "trunk");
		const report = await compile(s.options({ fetched: [api] }));
		expect(report.code?.[0]).toMatchObject({ branch: "trunk", commit: trunk, source: "origin" });
		expect(s.claude.calls()[0].files).toContain("api/trunk.ts");
	});

	it("reads the last fetch when the fetch failed, and the local default branch when never fetched (CMP-87)", async () => {
		const s = await setup(["api", "web"]);
		s.claude.setSteps([{ listFiles: true, answer: answer({ issues: [issue("api", "one")] }) }]);
		const api = join(s.project, "api");
		const web = join(s.project, "web");
		const teammate = await addOrigin(s.root, api);
		const fetchedCommit = await commitFiles(teammate, { "fetched.ts": "f\n" }, "Fetched");
		await git(teammate, ["push", "--quiet", "origin", "main"]);
		await git(api, ["fetch", "--quiet"]);
		// Pushed after the last fetch, which this compile's pull couldn't repeat.
		await commitFiles(teammate, { "unseen.ts": "u\n" }, "Not fetched");
		await git(teammate, ["push", "--quiet", "origin", "main"]);
		// web was never fetched: it has no origin/main at all.
		const local = await commitFiles(web, { "web.ts": "w\n" }, "Local web");
		s.github.offline = true;

		const report = await compile(s.options({ fetched: [] }));
		expect(report.status).toBe("succeeded");
		expect(report.code?.map((c) => [c.repo, c.branch, c.commit, c.source])).toEqual([
			["api", "main", fetchedCommit, "last-fetch"],
			["web", "main", local, "local"],
		]);
		const [call] = s.claude.calls();
		expect(call.files).toEqual(["api/README.md", "api/fetched.ts", "web/README.md", "web/web.ts"]);
		expect(call.prompt).toContain(`- api: main at ${fetchedCommit.slice(0, 7)} (origin/main as of the last fetch)`);
		expect(call.prompt).toContain(`- web: main at ${local.slice(0, 7)} (the local main: it was never fetched)`);
		expect(codeSnapshots()).toEqual([]);
	});

	it("doesn't start when the default branch can't be read, and the marker stays (CMP-88)", async () => {
		const s = await setup(["api", "web"]);
		const before = await repoState(join(s.project, "web"));
		s.github.defaultBranches.set("web", "trunk");
		await expect(startCompile(s.options(), () => {})).rejects.toThrow("Couldn't read trunk of web: Neither origin/trunk nor trunk is in it");
		expect(startFailure(false, new Error("Couldn't read trunk of web: x"))).toBe("Compile failed: Couldn't read trunk of web: x");
		expect(s.claude.calls()).toEqual([]);
		expect(await s.marker()).toBe("");
		expect(await repoState(join(s.project, "web"))).toEqual(before);
		// Neither snapshot is left behind.
		expect(readdirSync(temp as string).filter((name) => /^theory-(model|code)-/.test(name))).toEqual([]);
	});

	it("is deleted when the compile fails or is cancelled (CMP-89)", async () => {
		const s = await setup(["api"]);
		s.claude.setSteps([{}]);
		expect((await compile(s.options())).status).toBe("failed");
		expect(codeSnapshots()).toEqual([]);

		s.claude.setSteps([{ hang: true }]);
		await commitFiles(s.vault, { "Note.md": "# Note\n\nAnother rule.\n" }, "Another rule");
		const run = await startCompile(s.options(), () => {});
		while (s.claude.calls().length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
		expect(codeSnapshots()).toHaveLength(1);
		run.cancel();
		expect((await run.done).status).toBe("cancelled");
		expect(codeSnapshots()).toEqual([]);
	});

	it("fails the compile when the code snapshot changed, and says so after a cancel too (INV-14)", async () => {
		const s = await setup(["api"]);
		s.claude.setSteps([{ tamper: "api/evil.ts", answer: answer({ issues: [issue("api", "one")] }) }]);
		const report = await compile(s.options());
		expect(report.status).toBe("failed");
		expect(CODE_SNAPSHOT_CHANGED).toBe("Claude tried to change the code snapshot. Those changes were thrown away.");
		expect(report.problems.map((p) => p.text)).toContain(CODE_SNAPSHOT_CHANGED);
		expect(report.issues).toBeUndefined();
		expect(s.github.calls.filter((c) => c.startsWith("createIssue"))).toEqual([]);
		expect(existsSync(join(s.project, "api", "evil.ts"))).toBe(false);
		expect(codeSnapshots()).toEqual([]);

		// INV-12: checked after a cancelled run too, which stays cancelled.
		s.claude.setSteps([{ tamper: "api/evil.ts", hang: true }]);
		await commitFiles(s.vault, { "Note.md": "# Note\n\nAnother rule.\n" }, "Another rule");
		const run = await startCompile(s.options(), () => {});
		while (s.claude.calls().length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
		await new Promise((resolve) => setTimeout(resolve, 100));
		run.cancel();
		const cancelled = await run.done;
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.problems.map((p) => p.text)).toContain(CODE_SNAPSHOT_CHANGED);
		expect(codeSnapshots()).toEqual([]);
	});
});

describe("the plan (CMP-59 to CMP-62)", () => {
	const repos = ["api", "web"];

	it("is one issue, or an epic with its sub-issues in build order", () => {
		expect(readPlan({ issues: [issue("api", "one")] }, repos)).toEqual({ plan: { epic: null, issues: [issue("api", "one")] }, problems: [] });
		const subs = [issue("web", "first"), issue("api", "second"), issue("web", "third")];
		const { plan } = readPlan({ epic, issues: subs }, repos);
		expect(plan?.epic).toEqual(epic);
		expect(plan?.issues.map((i) => i.shortName)).toEqual(["first", "second", "third"]);
		expect(readPlan({ issues: [] }, repos).plan).toEqual({ epic: null, issues: [] });
	});

	it("refuses several issues without an epic, an epic with one sub-issue, and a repository not in the project folder", () => {
		expect(readPlan({ issues: [issue("api", "a"), issue("web", "b")] }, repos).problems).toEqual([
			"The plan has several issues and no epic. Several pieces of work need an epic.",
		]);
		expect(readPlan({ epic, issues: [issue("api", "a")] }, repos).problems).toEqual([
			'The epic "Ship the big thing" has fewer than two sub-issues. One piece of work is one issue.',
		]);
		// An epic with no sub-issues is a broken plan, not an empty one (CMP-70, CMP-71).
		expect(readPlan({ epic, issues: [] }, repos)).toEqual({
			plan: null,
			problems: ['The epic "Ship the big thing" has fewer than two sub-issues. One piece of work is one issue.'],
		});
		expect(readPlan({ issues: [issue("cli", "a")] }, repos).problems).toEqual([
			'The issue "Change a" names a repository that isn\'t in the project folder: "cli".',
		]);
		expect(readPlan(null, repos).problems).toEqual(["Claude's answer has no plan."]);
	});

	it("checks short names and titles", () => {
		expect(shortNameProblem("commit-page-diffs")).toBeNull();
		expect(shortNameProblem("a".repeat(40))).toBeNull();
		expect(shortNameProblem("a".repeat(41))).toBe(`The short name "${"a".repeat(41)}" is longer than 40 characters.`);
		for (const bad of ["Commit-page", "commit_page", "commit page", "-commit", "commit-", ""]) expect(shortNameProblem(bad)).not.toBeNull();
		expect(titleProblem("Show a diff for each file on the Commit page")).toBeNull();
		expect(titleProblem("x".repeat(69))).toBeNull();
		expect(titleProblem("x".repeat(70))).toBe(`The title "${"x".repeat(70)}" isn't under 70 characters.`);
		expect(titleProblem(" ")).toBe("An issue has no title.");
		expect(readPlan({ issues: [issue("api", "Bad Name", "x".repeat(80))] }, repos).problems).toEqual([
			`The issue "${"x".repeat(80)}" has a title that isn't under 70 characters.`,
			`The issue "${"x".repeat(80)}" has the short name "Bad Name", which may use only lowercase letters, digits and dashes.`,
		]);
	});

	it("names the issue in each short name and title problem, the epic's included (CMP-70)", () => {
		expect(readPlan({ epic: { ...epic, shortName: "x".repeat(41) }, issues: [issue("api", "a"), issue("web", "b_c")] }, repos).problems).toEqual([
			`The epic "Ship the big thing" has the short name "${"x".repeat(41)}", which is longer than 40 characters.`,
			'The issue "Change b_c" has the short name "b_c", which may use only lowercase letters, digits and dashes.',
		]);
		expect(readPlan({ issues: [issue("api", "one", "")] }, repos).problems).toEqual(['The issue with the short name "one" has no title.']);
		expect(readPlan({ issues: [{ ...issue("api", "one"), shortName: "" }] }, repos).problems).toEqual(['The issue "Change one" has no short name.']);
	});

	it("refuses an issue or an epic that lists no rule IDs (CMP-70)", () => {
		expect(readPlan({ issues: [{ ...issue("api", "one"), rules: [] }] }, repos).problems).toEqual(['The issue "Change one" lists no rule IDs.']);
		expect(readPlan({ issues: [{ ...issue("api", "one"), rules: [" ", 3] }] }, repos).problems).toEqual(['The issue "Change one" lists no rule IDs.']);
		expect(readPlan({ epic: { ...epic, rules: [] }, issues: [issue("api", "a"), issue("web", "b")] }, repos).problems).toEqual([
			'The epic "Ship the big thing" lists no rule IDs.',
		]);
	});

	it("refuses two issues with the same short name, the epic's included (CMP-70)", () => {
		expect(readPlan({ epic, issues: [issue("api", "a"), issue("web", "a", "Change a too")] }, repos).problems).toEqual([
			'The short name "a" is used more than once in the plan: The issue "Change a", The issue "Change a too".',
		]);
		expect(readPlan({ epic, issues: [issue("api", "big-thing"), issue("web", "b")] }, repos).problems).toEqual([
			'The short name "big-thing" is used more than once in the plan: The epic "Ship the big thing", The issue "Change big-thing".',
		]);
	});

	it("tells Claude that no two short names in a plan may be the same, as the plan check refuses them (CMP-61, CMP-70)", () => {
		const prompt = compilePrompt({
			snapshot: "/model",
			projectFolder: "/project",
			codeSnapshot: "/code",
			code: [],
			head: "abc1234",
			from: null,
			revisions: [],
			diff: "",
			instructions: [],
		});
		expect(prompt).toContain("Branches are named from it. No two short names in one plan are the same, the epic's included.");
	});

	for (const [name, plan, problem] of [
		["no rule IDs", { issues: [{ ...issue("api", "one"), rules: [] }] }, 'The issue "Change one" lists no rule IDs.'],
		[
			"a short name used twice",
			{ epic, issues: [issue("api", "a"), issue("web", "a", "Change a too")] },
			'The short name "a" is used more than once in the plan: The issue "Change a", The issue "Change a too".',
		],
		["an epic with no sub-issues", { epic, issues: [] }, 'The epic "Ship the big thing" has fewer than two sub-issues. One piece of work is one issue.'],
	] as const) {
		it(`fails a compile whose plan has ${name}, creates no issue, and moves the marker (CMP-17, CMP-63)`, async () => {
			const s = await setup();
			s.claude.setSteps([{ answer: answer(plan) }]);
			const report = await compile(s.options());
			expect(report.status).toBe("failed");
			expect(report.problems.map((p) => p.text)).toContain(problem);
			expect(s.github.issues).toEqual([]);
			expect(s.github.calls.filter((c) => /^(createLabel|createIssue|addSubIssue|addToProject)/.test(c))).toEqual([]);
			expect(await s.marker()).toBe("moved");
		});
	}

	it("fails a compile whose plan breaks the rules, creates nothing, and still moves the marker", async () => {
		const s = await setup();
		s.claude.setSteps([{ answer: answer({ issues: [issue("api", "a"), issue("web", "b")] }) }]);
		const report = await compile(s.options());
		expect(report.status).toBe("failed");
		expect(report.problems.map((p) => p.text)).toContain("The plan has several issues and no epic. Several pieces of work need an epic.");
		expect(s.github.issues).toEqual([]);
		expect(await s.marker()).toBe("moved");
	});

	it("creates nothing when Claude reports failed, and the marker moves (CMP-17)", async () => {
		const s = await setup();
		s.claude.setSteps([{ answer: answer({ issues: [issue("api", "a")] }, "failed") }]);
		const report = await compile(s.options());
		expect(report.status).toBe("failed");
		expect(s.github.issues).toEqual([]);
		expect(await s.marker()).toBe("moved");
	});
});

describe("nothing to build (CMP-15, CMP-71)", () => {
	it("succeeds with an empty plan, creates no issue, offers no Build and moves the marker", async () => {
		const s = await setup();
		s.claude.setSteps([{ answer: answer({ issues: [] }) }]);
		const report = await compile(s.options());
		expect(report.status).toBe("succeeded");
		expect(report.issues).toEqual([]);
		expect(report.problems).toEqual([]);
		expect(s.github.issues).toEqual([]);
		expect(s.github.calls.filter((c) => /^(createLabel|createIssue|addSubIssue|addToProject)/.test(c))).toEqual([]);
		expect(await s.marker()).toBe("moved");
		expect(compileFinishedText(report.issues ?? [], 0)).toBe("Compile finished. The code already matches the model.");
	});

	it("says the code already matches the model, or how many issues are ready, with the question count (CMP-16, CMP-21)", () => {
		expect(compileFinishedText([], 0)).toBe("Compile finished. The code already matches the model.");
		expect(compileFinishedText([], 1)).toBe("Compile finished. The code already matches the model. Claude has 1 question about the model.");
		expect(compileFinishedText([], 3)).toBe("Compile finished. The code already matches the model. Claude has 3 questions about the model.");
		const record = { kind: "issue" as const, repo: "api", repoPath: "/api", title: "T", body: "", rules: ["R-1"], shortName: "t" };
		expect(compileFinishedText([record], 0)).toBe("Compile finished. 1 issue is ready to build.");
		expect(compileFinishedText([record, record], 2)).toBe("Compile finished. 2 issues are ready to build. Claude has 2 questions about the model.");
	});
});

describe("creating the issues (CMP-63 to CMP-68)", () => {
	it("puts the epic in the repository with the most sub-issues, the first by name on a tie", () => {
		expect(epicRepo([{ repo: "web" }, { repo: "api" }, { repo: "web" }])).toBe("web");
		expect(epicRepo([{ repo: "web" }, { repo: "api" }])).toBe("api");
		expect(epicRepo([{ repo: "web" }, { repo: "cli" }, { repo: "api" }, { repo: "cli" }, { repo: "web" }])).toBe("cli");
	});

	it("creates one issue in its own repository, added to the project, and moves the marker", async () => {
		const s = await setup();
		s.claude.setSteps([{ answer: answer({ issues: [issue("web", "one", "Add one thing")] }) }]);
		const report = await compile(s.options());
		expect(report.status).toBe("succeeded");
		expect(s.github.issues.map((i) => [i.repo, i.title, i.labels, i.inProject])).toEqual([["web", "Add one thing", [], PROJECT_URL]]);
		expect(s.github.calls.some((c) => c.startsWith("ensureLabel"))).toBe(false);
		// The body ends with the revisions it was planned from (CMP-67).
		// HEAD is now the commit of the shared report, so the revision compiled is the one before it.
		const revision = report.toCommit.slice(0, 7);
		expect(s.github.issues[0].body).toBe(`Build one.\n\nRules: R-1\n\n---\nPlanned by theory.md from these revisions of the model:\n- ${revision} Initial commit`);
		expect(report.issues?.map((i) => [i.kind, i.repo, i.number, i.inProject])).toEqual([["issue", "web", 1, true]]);
		expect(readyText(report.issues ?? [])).toBe("1 issue is ready to build.");
		expect(await s.marker()).toBe("moved");
	});

	it("creates the epic first with the epic label, links each sub-issue to it, and adds every issue to the project", async () => {
		const s = await setup();
		s.claude.setSteps([{ answer: answer({ epic, issues: [issue("web", "first"), issue("api", "second"), issue("web", "third")] }) }]);
		const report = await compile(s.options());
		expect(report.status).toBe("succeeded");
		expect(s.github.calls.filter((c) => /^(createLabel|createIssue|addSubIssue)/.test(c))).toEqual([
			"createLabel web epic",
			"createIssue web Ship the big thing",
			"createIssue web Change first",
			"addSubIssue web#2 to web#1",
			"createIssue api Change second",
			"addSubIssue api#3 to web#1",
			"createIssue web Change third",
			"addSubIssue web#4 to web#1",
		]);
		expect(s.github.issues[0].labels).toEqual(["epic"]);
		expect(s.github.issues.every((i) => i.inProject === PROJECT_URL)).toBe(true);
		expect(report.issues?.map((i) => [i.kind, i.repo, i.number])).toEqual([
			["epic", "web", 1],
			["issue", "web", 2],
			["issue", "api", 3],
			["issue", "web", 4],
		]);
		expect(readyText(report.issues ?? [])).toBe("3 issues are ready to build.");
	});

	it("doesn't create the epic label when the repository has it", async () => {
		const s = await setup();
		s.github.labels.set("api", ["epic"]);
		s.claude.setSteps([{ answer: answer({ epic, issues: [issue("api", "first"), issue("api", "second")] }) }]);
		await compile(s.options());
		expect(s.github.calls.filter((c) => c.startsWith("createLabel"))).toEqual([]);
		expect(s.github.issues[0].labels).toEqual(["epic"]);
	});

	it("Retry creates only the issues still missing, then the marker moves", async () => {
		const s = await setup();
		s.claude.setSteps([{ answer: answer({ epic, issues: [issue("web", "first"), issue("api", "second")] }) }]);
		s.github.failures.set("createIssue", { at: 3, message: "HTTP 502" });
		const report = await compile(s.options(), ["retry"]);
		expect(report.status).toBe("succeeded");
		expect(report.issueFailure).toBeUndefined();
		expect(s.github.issues.map((i) => i.title)).toEqual(["Ship the big thing", "Change first", "Change second"]);
		expect(s.github.issues.map((i) => i.parent ?? null)).toEqual([null, "api#1", "api#1"]);
		expect(await s.marker()).toBe("moved");
		// The Retry updates the report shared while it waited, with every issue (REP-46).
		expect(await out(s.vault, ["log", "-1", "--format=%s"])).toBe(`Update compile ${report.shared!.shortId}`);
		const shared = JSON.parse(await out(s.vault, ["show", `HEAD:${report.shared!.file}`]));
		expect(shared.issues.map((i: { number: number }) => i.number)).toEqual([1, 2, 3]);
		expect(shared.status).toBe("succeeded");
	});

	it("stays running while Retry or Discard waits, so the report can offer them, and succeeds once every issue exists", async () => {
		const s = await setup();
		s.claude.setSteps([{ answer: answer({ epic, issues: [issue("web", "first"), issue("api", "second")] }) }]);
		s.github.failures.set("createIssue", { at: 2, message: "HTTP 502" });
		const statuses: string[] = [];
		let run: Awaited<ReturnType<typeof startCompile>>;
		run = await startCompile(s.options(), (report) => {
			if (!report.issueFailure || statuses.length) return;
			statuses.push(report.status);
			setTimeout(() => run.retryIssues(), 0);
		});
		const report = await run.done;
		expect(statuses).toEqual(["running"]);
		expect(report.status).toBe("succeeded");
		expect(await s.marker()).toBe("moved");
	});

	it("Cancel while Retry or Discard waits discards the issues and cancels the compile", async () => {
		const s = await setup();
		s.claude.setSteps([{ answer: answer({ epic, issues: [issue("web", "first"), issue("api", "second")] }) }]);
		s.github.failures.set("createIssue", { at: 2, message: "HTTP 502" });
		let run: Awaited<ReturnType<typeof startCompile>>;
		let asked = false;
		run = await startCompile(s.options(), (report) => {
			if (!report.issueFailure || asked) return;
			asked = true;
			setTimeout(() => run.cancel(), 0);
		});
		const report = await run.done;
		expect(report.status).toBe("cancelled");
		expect(s.github.issues.map((i) => [i.title, i.state, i.closedAs])).toEqual([["Ship the big thing", "closed", "not planned"]]);
		expect(await s.marker()).toBe("");
	});

	it("Discard closes the issues already created as not planned, fails the compile and leaves the marker in place", async () => {
		const s = await setup();
		s.claude.setSteps([{ answer: answer({ epic, issues: [issue("web", "first"), issue("api", "second")] }) }]);
		s.github.failures.set("addToProject", { at: 2, message: "HTTP 403" });
		const report = await compile(s.options(), ["discard"]);
		expect(report.status).toBe("failed");
		expect(s.github.issues.map((i) => [i.title, i.state, i.closedAs])).toEqual([
			["Ship the big thing", "closed", "not planned"],
			["Change first", "closed", "not planned"],
		]);
		expect(report.problems.map((p) => p.text)).toContain(
			"Couldn't create the issues: HTTP 403 The issues already created were closed as not planned, and the last compile marker didn't move.",
		);
		expect(await s.marker()).toBe("");
		// Shared once creating an issue failed, then committed again with markerMoved false (REP-46, CMP-22).
		const id = report.shared!.shortId;
		expect((await out(s.vault, ["log", "--format=%s", "-2"])).split("\n")).toEqual([`Update compile ${id}`, expect.stringMatching(/^Compile start\.\.[0-9a-f]{7}$/)]);
		expect(JSON.parse(await out(s.vault, ["show", `HEAD:${report.shared!.file}`]))).toMatchObject({ markerMoved: false, status: "failed" });
		expect(JSON.parse(await out(s.vault, ["show", `HEAD~1:${report.shared!.file}`]))).toMatchObject({ markerMoved: true });
	});
});

describe("a recompile (CMP-76 to CMP-79)", () => {
	const CONTINUE_RULE = "In a recompile, continue an earlier issue whenever the same work is still asked for in the same repository";

	it("starts the revisions and the diff where the earlier compile started, and lists its open issues in the prompt (CMP-10, CMP-76)", async () => {
		const s = await setup();
		const start = (await out(s.vault, ["rev-parse", "HEAD"])).trim();
		await markCompiled(s.vault, start);
		const first = await commitFiles(s.vault, { "Note.md": "# Note\n\nThe first rule.\n" }, "Write the first rule");
		s.claude.setSteps([
			{ answer: answer({ epic, issues: [issue("api", "one"), issue("web", "two")] }) },
			{
				answer: answer({
					epic: { ...epic, continues: 1, changed: "Now covers R-3, answered in the note." },
					issues: [{ ...issue("api", "one"), continues: 2, changed: "Now names R-3." }, issue("api", "three")],
				}),
			},
		]);
		const earlier = await compile(s.options());
		expect(earlier.status).toBe("succeeded");
		expect(earlier.fromCommit).toBe(start);
		// An issue closed since then is no longer open, so it isn't offered (CMP-76).
		s.github.issue("web", 3).state = "closed";
		const second = await commitFiles(s.vault, { "Note.md": "# Note\n\nThe answered rule.\n" }, "Answer the question");

		const report = await compile(s.options({ recompile: earlier }));
		expect(report.status).toBe("succeeded");
		expect(report.fromCommit).toBe(start);
		expect(report.recompileOf).toBe(earlier.id);
		expect(report.revisions.map((r) => r.hash)).toEqual([first, second]);

		const [plain, recompile] = s.claude.calls().map((c) => c.prompt);
		expect(plain).toContain(CONTINUE_RULE);
		expect(plain).not.toContain("This is a recompile");
		expect(plain).toContain(`Last compiled revision: ${start}`);
		expect(recompile).toContain(CONTINUE_RULE);
		expect(recompile).toContain("## This is a recompile");
		expect(recompile).toContain(`The earlier compile started from revision ${start}.`);
		expect(recompile).toContain(`- ${first.slice(0, 7)} `);
		expect(recompile).toContain(`- ${second.slice(0, 7)} `);
		// The diff covers the earlier compile's revisions too: from its start, not from the marker.
		expect(recompile).toContain("-The rule.");
		expect(recompile).toContain("+The answered rule.");
		expect(recompile).toContain("### #1: Ship the big thing\n\n- Repository: api\n- Kind: epic\n- Rules: R-1, R-2\n- Short name: big-thing\n\nSeveral pieces.");
		expect(recompile).toContain("### #2: Change one\n\n- Repository: api\n- Kind: issue\n- Rules: R-1\n- Short name: one\n\nBuild one.");
		expect(recompile).not.toContain("Change two");
	});

	it("recompiles another engineer's shared report, with its open issues' bodies read from GitHub (REP-50)", async () => {
		const s = await setup();
		const start = (await out(s.vault, ["rev-parse", "HEAD"])).trim();
		await markCompiled(s.vault, start);
		await commitFiles(s.vault, { "Note.md": "# Note\n\nThe first rule.\n" }, "Write the first rule");
		s.claude.setSteps([
			{ answer: answer({ epic, issues: [issue("api", "one"), issue("web", "two")] }) },
			{ answer: answer({ epic: { ...epic, continues: 1 }, issues: [{ ...issue("api", "one"), continues: 2 }, { ...issue("web", "two"), continues: 3 }] }) },
		]);
		const earlier = await compile(s.options());
		await commitFiles(s.vault, { "Note.md": "# Note\n\nThe answered rule.\n" }, "Answer the question");
		// As another engineer reads it from `.compiles/`: no issue bodies.
		const file = earlier.shared!.file;
		const theirs = fromSharedReport(JSON.parse(readFileSync(join(s.vault, file), "utf8")), file, s.project);
		expect(theirs.issues?.map((i) => i.body)).toEqual(["", "", ""]);

		const report = await compile(s.options({ recompile: theirs, reports: [theirs] }));
		expect(report.status).toBe("succeeded");
		expect(report.recompileOf).toBe(file);
		const recompile = s.claude.calls()[1].prompt;
		expect(recompile).toContain("- Short name: big-thing\n\nSeveral pieces.");
		expect(recompile).toContain("- Short name: one\n\nBuild one.");
		expect(recompile).not.toContain("Planned by theory.md");
		// Claude's bodies didn't change, so no continued issue gets the CMP-79 comment (CMP-80).
		expect(s.github.calls.filter((c) => c.startsWith("commentIssue"))).toEqual([]);
		// The earlier report's file now links the recompile (REP-41, REP-46).
		expect(JSON.parse(readFileSync(join(s.vault, file), "utf8")).recompiledBy).toBe(report.shared?.file);
	});

	it("lets the plan's epic and issues name the issue they continue and what changed (CMP-15)", () => {
		const props = PLAN_SCHEMA.properties;
		expect(Object.keys(props.epic.properties)).toEqual(expect.arrayContaining(["continues", "changed"]));
		expect(Object.keys(props.issues.items.properties)).toEqual(expect.arrayContaining(["continues", "changed"]));
		expect(props.issues.items.required).not.toContain("continues");
		expect(props.epic.required).not.toContain("changed");
	});

	describe("the limits on continuing (CMP-78)", () => {
		const repos = ["api", "web"];
		const record = (kind: "epic" | "issue", repo: string, number: number, shortName = `old-${number}`): IssueRecord => ({
			kind,
			repo,
			repoPath: `/project/${repo}`,
			title: `Old ${number}`,
			body: "Old body.",
			rules: ["R-1"],
			shortName,
			number,
		});
		const earlier = [record("epic", "api", 1), record("issue", "api", 2), record("issue", "web", 3)];
		const continuing = (item: object, continues: number) => ({ ...item, continues, changed: "Now covers R-2." });

		it("keeps a plan that continues open earlier issues of the same kind in the same repository", () => {
			const { plan, problems } = readPlan(
				{ epic: continuing(epic, 1), issues: [continuing(issue("api", "a"), 2), continuing(issue("web", "b"), 3)] },
				repos,
				earlier,
			);
			expect(problems).toEqual([]);
			expect(plan?.epic).toEqual({ ...epic, continues: 1, changed: "Now covers R-2." });
			expect(plan?.issues.map((i) => i.continues)).toEqual([2, 3]);
		});

		it("keeps an epic continued while most of its new sub-issues are in another repository (CMP-64)", () => {
			const plan = { epic: continuing(epic, 1), issues: [issue("web", "a"), issue("web", "b"), issue("api", "c")] };
			expect(readPlan(plan, repos, earlier).problems).toEqual([]);
		});

		it("refuses to continue an issue that isn't an open issue of the earlier compile", () => {
			expect(readPlan({ issues: [continuing(issue("api", "a"), 9)] }, repos, earlier).problems).toEqual([
				'The issue "Change a" continues #9, which isn\'t an open issue of the earlier compile.',
			]);
		});

		it("refuses an issue that moves to another repository", () => {
			expect(readPlan({ issues: [continuing(issue("web", "a"), 2)] }, repos, earlier).problems).toEqual([
				'The issue "Change a" continues api#2, which is in another repository. An issue must stay in its repository: "web" isn\'t "api".',
			]);
		});

		it("refuses an epic that continues an issue, and an issue that continues an epic", () => {
			expect(readPlan({ epic: continuing(epic, 2), issues: [issue("api", "a"), issue("web", "b")] }, repos, earlier).problems).toEqual([
				'The epic "Ship the big thing" continues api#2, which is an issue. An epic can only continue an epic.',
			]);
			expect(readPlan({ issues: [continuing(issue("api", "a"), 1)] }, repos, earlier).problems).toEqual([
				'The issue "Change a" continues api#1, which is an epic. An issue can only continue an issue.',
			]);
		});

		it("counts a sub-issue as an issue", () => {
			expect(readPlan({ epic, issues: [continuing(issue("api", "a"), 2), issue("web", "b")] }, repos, earlier).problems).toEqual([]);
			expect(readPlan({ epic, issues: [continuing(issue("api", "a"), 1), issue("web", "b")] }, repos, earlier).problems).toEqual([
				'The issue "Change a" continues api#1, which is an epic. An issue can only continue an issue.',
			]);
		});

		it("refuses an earlier issue continued twice", () => {
			expect(readPlan({ epic, issues: [continuing(issue("api", "a"), 2), continuing(issue("api", "b"), 2)] }, repos, earlier).problems).toEqual([
				'api#2 is continued more than once: The issue "Change a", The issue "Change b".',
			]);
		});

		it("tells apart earlier issues in different repositories that share a number", () => {
			const shared = [record("issue", "api", 4), record("issue", "web", 4)];
			expect(readPlan({ epic, issues: [continuing(issue("api", "a"), 4), continuing(issue("web", "b"), 4)] }, repos, shared).problems).toEqual([]);
		});

		it("refuses a plan that continues anything when the compile isn't a recompile", () => {
			expect(readPlan({ issues: [continuing(issue("api", "a"), 2)] }, repos).problems).toEqual([
				'The issue "Change a" continues #2, but this compile isn\'t a recompile, so it can\'t continue an earlier issue.',
			]);
			expect(readPlan({ epic: continuing(epic, 1), issues: [issue("api", "a"), issue("web", "b")] }, repos).problems).toEqual([
				'The epic "Ship the big thing" continues #1, but this compile isn\'t a recompile, so it can\'t continue an earlier issue.',
			]);
		});

		it("refuses a continued number that isn't an issue number", () => {
			expect(readPlan({ issues: [{ ...issue("api", "a"), continues: "2" }] }, repos, earlier).problems).toEqual([
				'The issue "Change a" continues something that isn\'t an issue number.',
			]);
		});

		it("fails a recompile whose plan breaks a limit, as CMP-17 says", async () => {
			const s = await setup();
			s.claude.setSteps([
				{ answer: answer({ issues: [issue("api", "one")] }) },
				{ answer: answer({ issues: [continuing(issue("web", "one"), 1)] }) },
			]);
			const first = await compile(s.options());
			await commitFiles(s.vault, { "Note.md": "# Note\n\nAnswered.\n" }, "Answer");
			const report = await compile(s.options({ recompile: first }));
			expect(report.status).toBe("failed");
			expect(report.problems.map((p) => p.text)).toContain(
				'The issue "Change one" continues api#1, which is in another repository. An issue must stay in its repository: "web" isn\'t "api".',
			);
			expect(s.github.issues).toHaveLength(1);
		});
	});
});

describe("bringing GitHub in line with a recompile (CMP-64, CMP-80 to CMP-83)", () => {
	const SYNC = /^(createIssue|editIssue|commentIssue|addSubIssue|removeSubIssue|closeIssue) /;
	const url = (repo: string, n: number) => `https://github.com/team/${repo}/issues/${n}`;

	/** Compiles `firstPlan`, commits an answer, and returns what a recompile needs. GitHub's calls start empty. */
	async function recompiling(firstPlan: unknown, secondAnswer: unknown) {
		const s = await setup();
		s.claude.setSteps([{ answer: answer(firstPlan) }, { answer: secondAnswer }]);
		const first = await compile(s.options());
		expect(first.status).toBe("succeeded");
		const before = structuredClone(first);
		await commitFiles(s.vault, { "Note.md": "# Note\n\nAnswered.\n" }, "Answer the question");
		const revision = (await out(s.vault, ["rev-parse", "--short=7", "HEAD"])).trim();
		s.github.calls = [];
		const head = (await out(s.vault, ["rev-parse", "HEAD"])).trim();
		/** Where the marker is now: "earlier" where the first compile left it, "head" once moved. */
		const marker = async () => {
			const at = (await markerCommit(s.vault)) ?? "";
			return at === head ? "head" : at === first.toCommit ? "earlier" : at;
		};
		return { s, first, before, revision, marker };
	}

	// Earlier: the epic api#1 with one (api#2), two (web#3) and three (api#4).
	const earlierPlan = { epic, issues: [issue("api", "one"), issue("web", "two"), issue("api", "three")] };

	it("creates, updates, links and closes, in that order, and comments only on what changed", async () => {
		const { s, first, before, revision , marker } = await recompiling(
			earlierPlan,
			answer({
				epic: { ...epic, body: "Several pieces, again.", continues: 1, changed: "Now covers R-3." },
				issues: [
					{ ...issue("api", "one", "Change one better"), continues: 2, changed: "Now names R-3, answered in the note." },
					{ ...issue("web", "two"), continues: 3, changed: "Covers the same." },
					issue("web", "four"),
				],
			}),
		);
		const report = await compile(s.options({ recompile: first }));
		expect(report.status).toBe("succeeded");
		expect(s.github.calls.filter((c) => SYNC.test(c))).toEqual([
			"createIssue web Change four",
			"addSubIssue web#5 to api#1",
			"editIssue api#1 Ship the big thing",
			"commentIssue api#1",
			"editIssue api#2 Change one better",
			"commentIssue api#2",
			"editIssue web#3 Change two",
			"commentIssue api#4",
			"closeIssue api#4 not planned",
		]);
		expect(s.github.issue("api", 2).comments).toEqual([`Now names R-3, answered in the note.\n\nPlanned again by theory.md from revision ${revision} of the model.`]);
		// Its title and body didn't change, so no comment (CMP-80 step 2).
		expect(s.github.issue("web", 3).comments).toEqual([]);
		expect(s.github.issue("web", 3).body).toContain(`- ${revision} Answer the question`);
		expect(s.github.issue("api", 4).comments).toEqual([`No longer planned after ${revision}. The new plan is ${url("api", 1)}.`]);
		expect([s.github.issue("api", 4).state, s.github.issue("api", 4).closedAs]).toEqual(["closed", "not planned"]);
		expect(s.github.issue("web", 5).inProject).toBe(PROJECT_URL);
		// The new report owns every issue it created or continued, in the new plan's order (CMP-83).
		expect(report.issues?.map((i) => [i.kind, i.repo, i.number, i.shortName])).toEqual([
			["epic", "api", 1, "big-thing"],
			["issue", "api", 2, "one"],
			["issue", "web", 3, "two"],
			["issue", "web", 5, "four"],
		]);
		expect(report.closing?.map((c) => [c.repo, c.number, c.closed])).toEqual([["api", 4, true]]);
		expect(await marker()).toBe("head");
		// The earlier report's records were never changed.
		expect(first).toEqual(before);
	});

	it("keeps a continued epic in its repository when another repository now has more sub-issues (CMP-64)", async () => {
		expect(epicRepo([{ repo: "web" }, { repo: "web" }, { repo: "api" }], { repo: "api" })).toBe("api");
		const { s, first , marker } = await recompiling(
			{ epic, issues: [issue("api", "one"), issue("api", "two")] },
			answer({ epic: { ...epic, continues: 1 }, issues: [issue("web", "three"), issue("web", "four"), { ...issue("api", "one"), continues: 2 }] }),
		);
		const report = await compile(s.options({ recompile: first }));
		expect(report.status).toBe("succeeded");
		expect(report.issues?.[0]).toMatchObject({ kind: "epic", repo: "api", number: 1 });
		expect(s.github.calls.filter((c) => c.startsWith("createIssue"))).toEqual(["createIssue web Change three", "createIssue web Change four"]);
		expect(s.github.issues.filter((i) => i.repo === "web").map((i) => i.parent)).toEqual(["api#1", "api#1"]);
		expect([s.github.issue("api", 3).state, s.github.issue("api", 3).comments]).toEqual(["closed", [expect.stringContaining(url("api", 1))]]);
	});

	it("takes a continued issue out of an epic that isn't in the plan, and closes the rest with the new issue named", async () => {
		const { s, first, revision , marker } = await recompiling(
			{ epic, issues: [issue("api", "one"), issue("web", "two")] },
			answer({ issues: [{ ...issue("api", "one"), continues: 2 }] }),
		);
		const report = await compile(s.options({ recompile: first }));
		expect(report.status).toBe("succeeded");
		expect(s.github.calls.filter((c) => SYNC.test(c))).toEqual([
			"editIssue api#2 Change one",
			"removeSubIssue api#2 from api#1",
			"commentIssue api#1",
			"closeIssue api#1 not planned",
			"commentIssue web#3",
			"closeIssue web#3 not planned",
		]);
		expect(s.github.issue("api", 2).parent).toBeUndefined();
		expect(s.github.issue("web", 3).comments).toEqual([`No longer planned after ${revision}. The new plan is ${url("api", 2)}.`]);
	});

	it("moves continued issues under a new epic, after leaving the old one", async () => {
		const { s, first , marker } = await recompiling(
			earlierPlan,
			answer({
				epic: { ...epic, title: "Ship it again", shortName: "again" },
				issues: [{ ...issue("api", "one"), continues: 2 }, { ...issue("web", "two"), continues: 3 }, issue("web", "five")],
			}),
		);
		const report = await compile(s.options({ recompile: first }));
		expect(report.status).toBe("succeeded");
		expect(s.github.calls.filter((c) => /^(createIssue|addSubIssue|removeSubIssue|closeIssue) /.test(c))).toEqual([
			"createIssue web Ship it again",
			"createIssue web Change five",
			"addSubIssue web#6 to web#5",
			"removeSubIssue api#2 from api#1",
			"addSubIssue api#2 to web#5",
			"removeSubIssue web#3 from api#1",
			"addSubIssue web#3 to web#5",
			"closeIssue api#1 not planned",
			"closeIssue api#4 not planned",
		]);
		expect(s.github.issues.filter((i) => i.state === "open").map((i) => `${i.repo}#${i.number} ${i.parent ?? ""}`)).toEqual([
			"api#2 web#5",
			"web#3 web#5",
			"web#5 ",
			"web#6 web#5",
		]);
	});

	it("puts a continued single issue under a new epic", async () => {
		const { s, first , marker } = await recompiling(
			{ issues: [issue("api", "one")] },
			answer({ epic, issues: [{ ...issue("api", "one"), continues: 1 }, issue("web", "two")] }),
		);
		const report = await compile(s.options({ recompile: first }));
		expect(report.status).toBe("succeeded");
		expect(s.github.issue("api", 1).parent).toBe("api#2");
		expect(s.github.issue("web", 3).parent).toBe("api#2");
		expect(s.github.issue("api", 1).state).toBe("open");
	});

	it("closes every earlier issue with its own comment when the new plan is empty (CMP-71)", async () => {
		const { s, first, revision , marker } = await recompiling({ issues: [issue("api", "one")] }, answer({ issues: [] }));
		const report = await compile(s.options({ recompile: first }));
		expect(report.status).toBe("succeeded");
		expect(report.issues).toEqual([]);
		expect(s.github.issue("api", 1).comments).toEqual([`The model no longer asks for this work (${revision}).`]);
		expect(s.github.issue("api", 1).closedAs).toBe("not planned");
		expect(await marker()).toBe("head");
	});

	// Earlier: epic api#1 with one api#2, two web#3, three api#4. The plan uses every GitHub method of the four steps.
	const everyStep = answer({
		epic: { ...epic, title: "Ship it again", shortName: "again" },
		issues: [{ ...issue("api", "one", "Change one better"), continues: 2, changed: "Now names R-3." }, { ...issue("web", "two"), continues: 3 }, issue("web", "five")],
	});
	const finalState = (github: FakeGitHub) =>
		github.issues.map((i) => [`${i.repo}#${i.number}`, i.title, i.state, i.parent ?? null, i.comments.length, i.inProject ?? null]);

	for (const [method, step, discard] of [
		["createIssue", "Couldn't create the issues", true],
		["editIssue", "Couldn't update the continued issues", true],
		["commentIssue", "Couldn't update the continued issues", false],
		["removeSubIssue", "Couldn't link the sub-issues", false],
		["addSubIssue", "Couldn't create the issues", true],
		["closeIssue", "Couldn't close the earlier issues", false],
	] as const) {
		it(`Retry after ${method} fails carries on from there (CMP-81)`, async () => {
			const clean = await recompiling(earlierPlan, everyStep);
			await compile(clean.s.options({ recompile: clean.first }));
			const expected = finalState(clean.s.github);

			const { s, first , marker } = await recompiling(earlierPlan, everyStep);
			s.github.failNext(method, "HTTP 502");
			const seen: { failure: string; canDiscard: boolean; left: string[] }[] = [];
			let run: Awaited<ReturnType<typeof startCompile>>;
			run = await startCompile(s.options({ recompile: first }), (report) => {
				if (!report.issueFailure || seen.length) return;
				seen.push({ failure: report.issueFailure, canDiscard: canDiscard(report.issues ?? [], report.closing), left: stepsLeft(report.issues ?? [], report.closing) });
				setTimeout(() => run.retryIssues(), 0);
			});
			const report = await run.done;
			expect(seen).toHaveLength(1);
			expect(seen[0].failure).toBe(`${step}: HTTP 502`);
			// Discard is offered only while no earlier issue has changed.
			expect(seen[0].canDiscard).toBe(discard);
			expect(seen[0].left.length).toBeGreaterThan(0);
			expect(seen[0].left.at(-1)).toBe("Close api#4 as not planned.");
			expect(report.status).toBe("succeeded");
			expect(finalState(s.github)).toEqual(expected);
			expect(await marker()).toBe("head");
		});
	}

	it("lists what's still to do when a step fails", async () => {
		const { s, first , marker } = await recompiling(earlierPlan, everyStep);
		s.github.failNext("removeSubIssue", "HTTP 502");
		let left: string[] = [];
		let run: Awaited<ReturnType<typeof startCompile>>;
		run = await startCompile(s.options({ recompile: first }), (report) => {
			if (!report.issueFailure || left.length) return;
			left = stepsLeft(report.issues ?? [], report.closing);
			setTimeout(() => run.retryIssues(), 0);
		});
		await run.done;
		expect(left).toEqual([
			"Remove api#2 from api#1.",
			"Link api#2 to web#5.",
			"Remove web#3 from api#1.",
			"Link web#3 to web#5.",
			"Close api#1 as not planned.",
			"Close api#4 as not planned.",
		]);
	});

	it("Discard before an earlier issue changed closes only the new issues, and the earlier ones stay as they were", async () => {
		const { s, first, before , marker } = await recompiling(earlierPlan, everyStep);
		s.github.failNext("editIssue", "HTTP 502");
		const report = await compile(s.options({ recompile: first }), ["discard"]);
		expect(report.status).toBe("failed");
		expect(s.github.issues.map((i) => [`${i.repo}#${i.number}`, i.title, i.state])).toEqual([
			["api#1", "Ship the big thing", "open"],
			["api#2", "Change one", "open"],
			["web#3", "Change two", "open"],
			["api#4", "Change three", "open"],
			["web#5", "Ship it again", "closed"],
			["web#6", "Change five", "closed"],
		]);
		expect(await marker()).toBe("earlier");
		expect(first).toEqual(before);
	});

	it("offers no Discard once an earlier issue changed: Discard does nothing, and Cancel stops without closing", async () => {
		const { s, first , marker } = await recompiling(earlierPlan, everyStep);
		s.github.failNext("commentIssue", "HTTP 502");
		let run: Awaited<ReturnType<typeof startCompile>>;
		let asked = false;
		run = await startCompile(s.options({ recompile: first }), (report) => {
			if (!report.issueFailure || asked) return;
			asked = true;
			setTimeout(() => {
				run.discardIssues();
				setTimeout(() => {
					expect(report.status).toBe("running");
					run.cancel();
				}, 20);
			}, 0);
		});
		const report = await run.done;
		expect(report.status).toBe("cancelled");
		expect(s.github.issues.every((i) => i.state === "open")).toBe(true);
		expect(s.github.issue("api", 2).title).toBe("Change one better");
		const text = report.problems.map((p) => p.text).join("\n");
		expect(text).toContain("Couldn't update the continued issues: HTTP 502 GitHub doesn't match the plan yet, and the last compile marker didn't move. Still to do: Update api#2.");
		expect(await marker()).toBe("earlier");
	});

	it("links the two reports, and says where each issue went (REP-41, REP-42)", async () => {
		const { s, first } = await recompiling(
			earlierPlan,
			answer({
				epic: { ...epic, continues: 1, changed: "Covers the same." },
				issues: [{ ...issue("api", "one"), continues: 2, changed: "Covers the same." }, issue("web", "four")],
			}),
		);
		// Before the recompile, the earlier report has no link and its issues went nowhere.
		expect(recompiledBy(first, [first])).toBeNull();
		const report = await compile(s.options({ recompile: first }));
		const reports = [report, first];
		// The links live in the reports themselves (REP-10): the recompile names the earlier compile.
		expect(report.recompileOf).toBe(first.id);
		expect(report.earlier).toEqual({ startedAt: first.startedAt, fromCommit: first.fromCommit, toCommit: first.toCommit });
		expect(recompiledBy(first, reports)).toBe(report);
		expect(recompiledReport(report, reports)).toBe(first);
		expect(recompiledBy(report, reports)).toBeNull();
		expect(recompiledReport(first, reports)).toBeNull();
		// The earlier report's issues: the epic and one continued, two and three closed (REP-41).
		expect(first.issues?.map((i) => [i.repo, i.number, issueFate(i, report)])).toEqual([
			["api", 1, "continued"],
			["api", 2, "continued"],
			["web", 3, "closed"],
			["api", 4, "closed"],
		]);
		// The recompile's issues: new or continued, and the closed ones after (REP-42).
		expect(report.issues?.map((i) => [i.repo, i.number, issueOrigin(i)])).toEqual([
			["api", 1, "continued"],
			["api", 2, "continued"],
			["web", 5, "new"],
		]);
		expect(report.closing?.filter((c) => c.closed).map((c) => [c.repo, c.number])).toEqual([
			["web", 3],
			["api", 4],
		]);
		// An issue the recompile hasn't closed yet went nowhere so far.
		const pending = { ...report, closing: report.closing?.map((c) => ({ ...c, closed: false })) };
		expect(issueFate(first.issues![2], pending)).toBeNull();
	});

	it("says in compile-start and compile-end that it is a recompile, with the issues created, continued and closed (HOOK-3)", async () => {
		const { s, first } = await recompiling(
			earlierPlan,
			answer({
				epic: { ...epic, continues: 1, changed: "Covers the same." },
				issues: [{ ...issue("api", "one", "Change one better"), continues: 2, changed: "Now says more." }, issue("web", "four")],
			}),
		);
		// A compile's events say nothing of a recompile.
		expect(compileStartDetails(first)).toEqual({ status: "running", revisions: 1 });
		expect(compileEndDetails(first)).not.toHaveProperty("recompile");
		expect(compileEndDetails(first)).not.toHaveProperty("continued");

		const report = await compile(s.options({ recompile: first }));
		const earlier = { date: first.startedAt, from: first.fromCommit, to: first.toCommit };
		expect(compileStartDetails(report)).toEqual({ status: "running", revisions: 2, recompile: true, earlier });
		const details = (kind: string, repo: string, number: number, title: string) => ({ kind, repo, number, title, url: url(repo, number) });
		expect(compileEndDetails(report)).toEqual({
			status: "succeeded",
			summary: "Planned.",
			questions: 0,
			issues: [
				{ repo: "api", number: 2, title: "Change one better", url: url("api", 2) },
				{ repo: "web", number: 5, title: "Change four", url: url("web", 5) },
			],
			epic: { repo: "api", number: 1, title: "Ship the big thing", url: url("api", 1) },
			recompile: true,
			earlier,
			created: [details("issue", "web", 5, "Change four")],
			continued: [details("epic", "api", 1, "Ship the big thing"), details("issue", "api", 2, "Change one better")],
			closed: [details("issue", "web", 3, "Change two"), details("issue", "api", 4, "Change three")],
		});
	});

	it("lists nothing as created, continued or closed in compile-end when the recompile failed before step 1 (CMP-82, HOOK-3)", async () => {
		const { s, first } = await recompiling(earlierPlan, answer({ issues: [] }, "failed"));
		const report = await compile(s.options({ recompile: first }));
		expect(compileEndDetails(report)).toMatchObject({ status: "failed", recompile: true, issues: [], epic: null, created: [], continued: [], closed: [] });
		// The earlier compile doesn't count as recompiled (CMP-82).
		expect(recompiledBy(first, [report, first])).toBeNull();
	});

	it("leaves the earlier compile's issues and report as they were when a recompile fails (CMP-82)", async () => {
		const { s, first, before , marker } = await recompiling(earlierPlan, answer({ issues: [] }, "failed"));
		const issues = structuredClone(s.github.issues);
		const report = await compile(s.options({ recompile: first }));
		expect(report.status).toBe("failed");
		expect(s.github.calls.filter((c) => SYNC.test(c))).toEqual([]);
		expect(s.github.issues).toEqual(issues);
		expect(first).toEqual(before);
		// The marker follows CMP-22: Claude ran.
		expect(await marker()).toBe("head");
	});
});

describe("offering Recompile (CMP-72 to CMP-74)", () => {
	const record = (n: number, extra: Partial<IssueRecord> = {}): IssueRecord => ({
		kind: "issue",
		repo: "api",
		repoPath: "/project/api",
		title: `Change ${n}`,
		body: "Build it.",
		rules: ["R-1"],
		shortName: `change-${n}`,
		number: n,
		...extra,
	});
	const report = (id: string, startedAt: string, extra: Partial<CompileReport> = {}): CompileReport => ({
		id,
		status: "succeeded",
		startedAt,
		fromCommit: null,
		toCommit: "abc",
		revisions: [],
		summary: "",
		changes: [],
		questions: [],
		problems: [],
		log: [],
		issues: [record(1)],
		...extra,
	});
	const earlier = () => report("1", "2026-11-01T10:00:00.000Z");

	it("is offered for a compile that created issues, nothing built and no later compile", () => {
		const r = earlier();
		expect(recompileBlocker(r, [r])).toBeNull();
		expect(recompileButton(r, [r], 1, false)).toEqual({ shown: true, disabled: false });
	});

	it("is hidden for a compile that created no issue", () => {
		for (const r of [
			report("1", "2026-11-01T10:00:00.000Z", { issues: [] }),
			report("1", "2026-11-01T10:00:00.000Z", { status: "failed" }),
			report("1", "2026-11-01T10:00:00.000Z", { issues: [record(1, { number: undefined })] }),
		]) {
			expect(recompileButton(r, [r], 1, false)).toEqual({ shown: false });
		}
	});

	it("is hidden once a later compile succeeded, and not for a later one that failed", () => {
		const r = earlier();
		const failed = report("2", "2026-11-02T10:00:00.000Z", { status: "failed", issues: [] });
		expect(recompileBlocker(r, [failed, r])).toBeNull();
		const later = report("2", "2026-11-02T10:00:00.000Z", { issues: [] });
		expect(recompileBlocker(r, [later, r])).toMatch(/^A later compile succeeded/);
		expect(recompileButton(r, [later, r], 1, false)).toEqual({ shown: false });
		// An older compile that succeeded doesn't count.
		const older = report("0", "2026-10-01T10:00:00.000Z");
		expect(recompileBlocker(r, [r, older])).toBeNull();
	});

	it("is hidden once an issue of its plan has a build branch or a pull request", () => {
		const branch = report("1", "2026-11-01T10:00:00.000Z", { issues: [record(1, { branch: "theory/1-change-1" })] });
		expect(recompileBlocker(branch, [branch])).toBe("api#1 has been built on theory/1-change-1.");
		const epicBranch = report("1", "2026-11-01T10:00:00.000Z", {
			build: { status: "stopped", startedAt: "x", epicBranches: [{ repo: "api", repoPath: "/project/api", branch: "theory/epic-1-big", base: "main" }] },
		});
		expect(recompileBlocker(epicBranch, [epicBranch])).toBe("A build made the epic branch theory/epic-1-big.");
		const pr = report("1", "2026-11-01T10:00:00.000Z", {
			pullRequests: [{ repo: "api", repoPath: "/project/api", branch: "theory/1-change-1", base: "main", url: "https://github.com/team/api/pull/9", state: "open" }],
		});
		expect(recompileBlocker(pr, [pr])).toBe("A pull request was opened for this compile: https://github.com/team/api/pull/9");
		for (const r of [branch, epicBranch, pr]) expect(recompileButton(r, [r], 1, false)).toEqual({ shown: false });
	});

	it("is hidden once recompiled, but not after a recompile that failed without changing an earlier issue (CMP-82)", () => {
		const r = earlier();
		const done = report("2", "2026-11-02T10:00:00.000Z", { recompileOf: "1", status: "succeeded" });
		// A recompile is a later compile too; the reason names the recompile.
		expect(recompileBlocker(r, [done, r])).toBe("This compile has been recompiled already.");
		const failedEarly = report("2", "2026-11-02T10:00:00.000Z", { recompileOf: "1", status: "failed", issues: [] });
		expect(recompileBlocker(r, [failedEarly, r])).toBeNull();
		const touched = report("2", "2026-11-02T10:00:00.000Z", {
			recompileOf: "1",
			status: "failed",
			issues: [record(1, { continued: { title: "Change 1", body: "Build it.", updated: true, touched: true } })],
		});
		expect(recompileBlocker(r, [touched, r])).toBe("This compile has been recompiled already.");
		expect(recompileButton(r, [touched, r], 1, false)).toEqual({ shown: false });
	});

	it("is disabled with no pending revision, and says to commit the answers first (CMP-74)", () => {
		const r = earlier();
		expect(recompileButton(r, [r], 0, false)).toEqual({ shown: true, disabled: true, tooltip: COMMIT_ANSWERS_FIRST });
		expect(COMMIT_ANSWERS_FIRST).toBe("Commit your answers to the model first.");
		// Disabled while the count is unknown, and while a compile or build runs (CMP-3).
		expect(recompileButton(r, [r], null, false)).toEqual({ shown: true, disabled: true });
		expect(recompileButton(r, [r], 2, true)).toEqual({ shown: true, disabled: true });
	});
});

describe("the checks before a recompile (CMP-75)", () => {
	/** A compile that created api#1, then a committed answer, so a recompile has a pending revision. */
	async function compiled() {
		const s = await setup();
		s.claude.setSteps([{ answer: answer({ issues: [issue("api", "one")] }) }, { answer: answer({ issues: [{ ...issue("api", "one"), continues: 1, changed: "Now says more." }] }) }]);
		const first = await compile(s.options());
		expect(first.status).toBe("succeeded");
		await commitFiles(s.vault, { "Note.md": "# Note\n\nAnswered.\n" }, "Answer the question");
		s.github.calls = [];
		const markerAt = async () => (await markerCommit(s.vault)) ?? "";
		const before = await markerAt();
		const recompile = (extra: Partial<CompileOptions> = {}) => s.options({ recompile: first, reports: [first], ...extra });
		/** The notice a recompile that can't start shows, as runCompile builds it. */
		const notice = async (options: CompileOptions) => {
			const error = await startCompile(options, () => {}).then(
				() => null,
				(e: unknown) => e,
			);
			expect(error).not.toBeNull();
			return startFailure(true, error);
		};
		return { s, first, markerAt, before, recompile, notice };
	}

	it("starts its messages with Recompile failed, and a compile's with Compile failed", () => {
		expect(failedPrefix(true)).toBe("Recompile failed");
		expect(failedPrefix(false)).toBe("Compile failed");
		expect(startFailure(true, new Error("Something."))).toBe("Recompile failed: Something.");
		expect(startFailure(false, new Error("Something."))).toBe("Compile failed: Something.");
		expect(startFailure(true, new IdentityError("Tell git who you are first."))).toBe("Tell git who you are first.");
	});

	it("stops on the project folder first: not set, then missing (CMP-6, CMP-7)", async () => {
		const c = await compiled();
		expect(await c.notice(c.recompile({ projectFolder: "" }))).toBe("Recompile failed: Choose the project folder in theory.md settings first.");
		const gone = join(c.s.root, "gone");
		expect(await c.notice(c.recompile({ projectFolder: gone }))).toBe(`Recompile failed: The project folder doesn't exist: ${gone}`);
		expect(await c.markerAt()).toBe(c.before);
	});

	it("stops on each code check in order, with its message, and the marker stays (CMP-36, CMP-55 to CMP-57)", async () => {
		const c = await compiled();
		// Every check fails, and CMP-73 too: each is fixed in turn to reach the next.
		await out(join(c.s.project, "api"), ["branch", "theory/1-one"]);
		write(join(c.s.project, "web"), { "wip.ts": "wip\n" });
		c.s.github.loggedIn = false;
		c.s.github.noOrigin.add("web");
		const project = { githubProject: "" };
		expect(await c.notice(c.recompile(project))).toBe(
			"Recompile failed: These repositories have uncommitted changes: web. Commit or stash them first.",
		);
		await out(join(c.s.project, "web"), ["clean", "-fdq"]);
		expect(await c.notice(c.recompile(project))).toBe(`Recompile failed: ${GH_LOGIN}`);
		c.s.github.loggedIn = true;
		expect(await c.notice(c.recompile(project))).toBe("Recompile failed: These repositories have no GitHub origin: web.");
		c.s.github.noOrigin.clear();
		expect(await c.notice(c.recompile(project))).toBe(`Recompile failed: ${NO_PROJECT}`);
		c.s.github.projectError = "HTTP 404";
		expect(await c.notice(c.recompile())).toBe(`Recompile failed: Couldn't reach the GitHub Project ${PROJECT_URL}: HTTP 404`);
		c.s.github.projectError = null;
		// CMP-73 last of all: a build branch made since the report was drawn.
		expect(await c.notice(c.recompile())).toBe("Recompile failed: The build branch theory/1-one exists in api.");
		expect(c.s.claude.calls()).toHaveLength(1);
		expect(await c.markerAt()).toBe(c.before);
	});

	it("stops when CMP-73 no longer holds at start, and the marker stays", async () => {
		const c = await compiled();
		// A build branch only on origin, as git last fetched it.
		const api = join(c.s.project, "api");
		await out(api, ["update-ref", "refs/remotes/origin/theory/1-one", "HEAD"]);
		expect(await c.notice(c.recompile())).toBe("Recompile failed: The build branch theory/1-one exists in api.");
		await out(api, ["update-ref", "-d", "refs/remotes/origin/theory/1-one"]);

		// The name was taken, so the build made `-2` (BLD-12), here or only on origin.
		await out(api, ["branch", "theory/1-one-2"]);
		expect(await buildBranch(api, "theory/1-one")).toBe("theory/1-one-2");
		expect(await c.notice(c.recompile())).toBe("Recompile failed: The build branch theory/1-one-2 exists in api.");
		await out(api, ["branch", "-D", "theory/1-one-2"]);
		await out(api, ["update-ref", "refs/remotes/origin/theory/1-one-3", "HEAD"]);
		expect(await c.notice(c.recompile())).toBe("Recompile failed: The build branch theory/1-one-3 exists in api.");
		await out(api, ["update-ref", "-d", "refs/remotes/origin/theory/1-one-3"]);
		// Another issue's branch is not this one's: a longer short name, or another number.
		await out(api, ["branch", "theory/1-one-more"]);
		await out(api, ["branch", "theory/11-one"]);
		expect(await buildBranch(api, "theory/1-one")).toBeNull();
		await out(api, ["branch", "-D", "theory/1-one-more", "theory/11-one"]);

		// A pull request opened since the report was drawn.
		const withPr: CompileReport = {
			...c.first,
			pullRequests: [{ repo: "api", repoPath: api, branch: "theory/1-one", base: "main", url: "https://github.com/team/api/pull/5", state: "open" }],
		};
		expect(await c.notice(c.recompile({ recompile: withPr, reports: [withPr] }))).toBe(
			"Recompile failed: A pull request was opened for this compile: https://github.com/team/api/pull/5",
		);

		// A later compile that succeeded.
		const later: CompileReport = { ...c.first, id: "later", startedAt: new Date(Date.now() + 1000).toISOString(), issues: [] };
		expect(await c.notice(c.recompile({ reports: [later, c.first] }))).toMatch(/^Recompile failed: A later compile succeeded/);

		// Recompiled already.
		const again: CompileReport = { ...c.first, id: "again", recompileOf: c.first.id, startedAt: c.first.startedAt };
		expect(await c.notice(c.recompile({ reports: [again, c.first] }))).toBe("Recompile failed: This compile has been recompiled already.");

		expect(c.s.claude.calls()).toHaveLength(1);
		// Nothing changed on GitHub: the earlier issues stay as they were (CMP-82).
		expect(c.s.github.calls.filter((call) => /^(createIssue|editIssue|commentIssue|closeIssue|addSubIssue|removeSubIssue) /.test(call))).toEqual([]);
		expect(await c.markerAt()).toBe(c.before);
	});

	it("runs once every check passes", async () => {
		const c = await compiled();
		const report = await compile(c.recompile());
		expect(report.status).toBe("succeeded");
		expect(report.recompileOf).toBe(c.first.id);
	});
});

describe("the shared report of a compile (REP-46, CMP-22, CMP-90)", () => {
	const filesIn = async (vault: string) => (await out(vault, ["show", "--name-only", "--format=", "HEAD"])).split("\n").filter(Boolean).sort();

	it("commits the report and its Activity log once when a compile ends, which moves the marker", async () => {
		const s = await setup();
		const compiled = await out(s.vault, ["rev-parse", "HEAD"]);
		const report = await compile(s.options());
		expect(report.status).toBe("succeeded");
		const file = report.shared!.file;
		expect(await out(s.vault, ["log", "-1", "--format=%s"])).toBe(`Compile start..${compiled.slice(0, 7)}`);
		expect(await out(s.vault, ["rev-list", "--count", `${compiled}..HEAD`])).toBe("1");
		expect(await filesIn(s.vault)).toEqual([file.replace(/\.json$/, ".activity.log"), file].sort());
		expect(await markerCommit(s.vault)).toBe(compiled);
		// The shared report's own commit is in a dot folder, so nothing is pending (INV-13).
		expect(await pendingRevisionCount(s.vault)).toBe(0);
		await expect(startCompile(s.options(), () => {})).rejects.toThrow("Every committed revision is already compiled.");
	});

	it("with Share compile reports off, writes no shared file and moves the local tag instead (CFG-44)", async () => {
		const s = await setup();
		const compiled = await out(s.vault, ["rev-parse", "HEAD"]);
		// As the plugin does with the setting off: the same share, told not to share.
		const local = (extra: Partial<CompileOptions> = {}) =>
			s.options({
				shareReports: false,
				share: async (report) => {
					const moment = compileMoment(report);
					if (moment) await shareReport({ vaultPath: s.vault, reports: [report], push: () => pushVault(s.vault), sharing: false }, report, moment);
				},
				...extra,
			});
		const report = await compile(local());
		expect(report.status).toBe("succeeded");
		expect(report.markerMoved).toBe(true);
		expect(report.shared).toBeUndefined();
		expect(existsSync(join(s.vault, ".compiles"))).toBe(false);
		expect(await out(s.vault, ["rev-parse", "HEAD"])).toBe(compiled);
		expect(await out(s.vault, ["rev-parse", "refs/tags/theory/compiled"])).toBe(compiled);
		expect(await markerCommit(s.vault, false)).toBe(compiled);
		expect(await markerCommit(s.vault)).toBeNull();
		await expect(startCompile(local(), () => {})).rejects.toThrow("Every committed revision is already compiled.");

		// The next compile starts from the tag.
		const next = await commitFiles(s.vault, { "Note.md": "# Note\n\nChanged.\n" }, "Change the rule");
		s.claude.setSteps([{ answer: answer({ issues: [issue("api", "two")] }) }]);
		const second = await compile(local());
		expect(second.fromCommit).toBe(compiled);
		expect(await out(s.vault, ["rev-parse", "refs/tags/theory/compiled"])).toBe(next);
		expect(existsSync(join(s.vault, ".compiles"))).toBe(false);
	});

	it("commits nothing when the compile can't start", async () => {
		const s = await setup();
		const head = await out(s.vault, ["rev-parse", "HEAD"]);
		await expect(startCompile(s.options({ githubProject: "" }), () => {})).rejects.toThrow(NO_PROJECT);
		expect(await out(s.vault, ["rev-parse", "HEAD"])).toBe(head);
		expect(existsSync(join(s.vault, ".compiles"))).toBe(false);
	});

	it("commits nothing when the compile is cancelled while Claude runs, and the marker stays (CMP-23, REP-10)", async () => {
		const s = await setup(["api"]);
		const head = await out(s.vault, ["rev-parse", "HEAD"]);
		s.claude.setSteps([{ hang: true }]);
		const run = await startCompile(s.options(), () => {});
		while (s.claude.calls().length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
		run.cancel();
		const report = await run.done;
		expect(report.status).toBe("cancelled");
		expect(report.shared).toBeUndefined();
		expect(await out(s.vault, ["rev-parse", "HEAD"])).toBe(head);
		expect(existsSync(join(s.vault, ".compiles"))).toBe(false);
		expect(await markerCommit(s.vault)).toBeNull();
	});

	it("commits both reports of a recompile in one commit, and the recompile moves the marker", async () => {
		const s = await setup();
		s.claude.setSteps([
			{ answer: answer({ issues: [issue("api", "one")] }) },
			{ answer: answer({ issues: [{ ...issue("api", "one"), continues: 1, changed: "Now says more." }] }) },
		]);
		const first = await compile(s.options());
		const answered = await commitFiles(s.vault, { "Note.md": "# Note\n\nAnswered.\n" }, "Answer the question");
		const second = await compile(s.options({ recompile: first, reports: [first] }));
		expect(second.status).toBe("succeeded");
		expect(await out(s.vault, ["log", "-1", "--format=%s"])).toBe(`Recompile ${first.shared!.shortId}`);
		const files = await filesIn(s.vault);
		expect(files).toContain(first.shared!.file);
		expect(files).toContain(second.shared!.file);
		expect(JSON.parse(await out(s.vault, ["show", `HEAD:${first.shared!.file}`])).recompiledBy).toBe(second.shared!.file);
		expect(await markerCommit(s.vault)).toBe(answered);
	});
});

describe("a compile's tokens (REP-56)", () => {
	it("keeps the tokens in four parts with the model that ran, in the report and in its shared file", async () => {
		const s = await setup();
		s.claude.setSteps([
			{
				answer: answer({ issues: [issue("api", "one")] }),
				model: "claude-opus-5-5",
				usage: { input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 5000, cache_read_input_tokens: 90000 },
			},
		]);
		const report = await compile(s.options());
		expect(report.status).toBe("succeeded");
		const parts = { input: 1200, output: 340, cacheWrites: 5000, cacheReads: 90000, model: "claude-opus-5-5" };
		expect(report.tokens).toEqual(parts);
		// Teammates see the cost too (UI-16), so the parts are shared.
		expect(JSON.parse(await out(s.vault, ["show", `HEAD:${report.shared!.file}`])).tokens).toEqual(parts);
	});

	it("keeps no tokens when Claude Code reports none, so the report says Not reported", async () => {
		const s = await setup();
		s.claude.setSteps([{ answer: answer({ issues: [issue("api", "one")] }), usage: null }]);
		const report = await compile(s.options());
		expect(report.tokens).toBeUndefined();
		expect(JSON.parse(await out(s.vault, ["show", `HEAD:${report.shared!.file}`]))).not.toHaveProperty("tokens");
	});
});
