import { join } from "path";
import { describe, expect, it } from "vitest";
import {
	COMPILED_TAG,
	CompileOptions,
	CompileReport,
	GH_LOGIN,
	NO_PROJECT,
	READ_ONLY_TOOLS,
	claudeArgs,
	startCompile,
} from "../src/compile";
import { compileFinishedText, epicRepo, issueBody, readPlan, readyText, shortNameProblem, titleProblem } from "../src/plan";
import { FakeGitHub } from "./fake-github";
import { fakeClaude } from "./fake-claude";
import { initRepo, out, tempFolder, write } from "./helpers";

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
	const marker = () => out(vault, ["tag", "--list", COMPILED_TAG]);
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
		expect(call.cwd).toBe(s.project);
		expect(call.args[call.args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
		expect(call.prompt).toContain("Never change a file anywhere");
		expect(call.prompt).toContain("Never create issues, branches or pull requests, and never touch GitHub.");
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
			expect(await s.marker()).toBe(COMPILED_TAG);
		});
	}

	it("fails a compile whose plan breaks the rules, creates nothing, and still moves the marker", async () => {
		const s = await setup();
		s.claude.setSteps([{ answer: answer({ issues: [issue("api", "a"), issue("web", "b")] }) }]);
		const report = await compile(s.options());
		expect(report.status).toBe("failed");
		expect(report.problems.map((p) => p.text)).toContain("The plan has several issues and no epic. Several pieces of work need an epic.");
		expect(s.github.issues).toEqual([]);
		expect(await s.marker()).toBe(COMPILED_TAG);
	});

	it("creates nothing when Claude reports failed, and the marker moves (CMP-17)", async () => {
		const s = await setup();
		s.claude.setSteps([{ answer: answer({ issues: [issue("api", "a")] }, "failed") }]);
		const report = await compile(s.options());
		expect(report.status).toBe("failed");
		expect(s.github.issues).toEqual([]);
		expect(await s.marker()).toBe(COMPILED_TAG);
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
		expect(await s.marker()).toBe(COMPILED_TAG);
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
		const revision = (await out(s.vault, ["rev-parse", "--short=7", "HEAD"])).trim();
		expect(s.github.issues[0].body).toBe(`Build one.\n\nRules: R-1\n\n---\nPlanned by theory.md from these revisions of the model:\n- ${revision} Initial commit`);
		expect(report.issues?.map((i) => [i.kind, i.repo, i.number, i.inProject])).toEqual([["issue", "web", 1, true]]);
		expect(readyText(report.issues ?? [])).toBe("1 issue is ready to build.");
		expect(await s.marker()).toBe(COMPILED_TAG);
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
		expect(await s.marker()).toBe(COMPILED_TAG);
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
		expect(await s.marker()).toBe(COMPILED_TAG);
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
	});
});
