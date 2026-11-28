import { readFileSync } from "fs";
import { basename, join } from "path";
import { describe, expect, it } from "vitest";
import { type AgentSettings, type CompileOptions, type CompileReport, claudeArgs, pendingRevisionCount, startCompile } from "../src/compile";
import { structuredAnswer } from "../src/acp";
import { reportCosts } from "../src/costs";
import { compileEndDetails } from "../src/hooks";
import { parseModelDiff } from "../src/model-diff";
import {
	CHECKING_LABEL,
	CHECKING_TOOLTIP,
	QUESTION_PASS_SCHEMA,
	askedQuestionsText,
	checkingModel,
	compileAnywayShown,
	nothingToChangeText,
	questionPassLine,
	questionsNotice,
	readQuestionPassAnswer,
	wordingOnly,
} from "../src/question-pass";
import { STATUS_TEXT } from "../src/report-list";
import { compileMoment, fromSharedReport, markerCommit, parseSharedReport, shareReport, toSharedReport } from "../src/shared-report";
import { pushVault } from "../src/push";
import { FakeGitHub } from "./fake-github";
import { type FakeStep, fakeClaude } from "./fake-claude";
import { commitFiles, initRepo, markCompiled, out, tempFolder } from "./helpers";

const PROJECT_URL = "https://github.com/orgs/team/projects/1";

const issue = (repo: string, shortName: string) => ({ repo, title: `Change ${shortName}`, body: `Build ${shortName}.`, rules: ["R-1"], shortName });
const plan = (issues: unknown[]) => ({ status: "succeeded", summary: "Planned.", plan: { issues }, questions: [], problems: [] });
const question = (text: string) => ({
	question: text,
	notes: ["Note.md"],
	anchors: [{ path: "Note.md", heading: "Note", quote: "**R-1.** The rule." }],
});
/** The question pass's answer (CMP-99). */
const checked = (questions: unknown[], changesCode: "some" | "none" = "some", why = "The rule changed.") => ({ questions, changesCode, why });

/**
 * A vault with one pending revision after a compile marker, and a project folder holding `api`. The pending revision
 * rewords the rule's reason only, unless `change` says otherwise.
 */
async function setup(steps: FakeStep[], change: Record<string, string> = { "Note.md": "# Note\n\n**R-1.** The rule. Why: a better reason.\n" }) {
	const root = tempFolder();
	const vault = join(root, "vault");
	const project = join(root, "project");
	await initRepo(vault, { "Note.md": "# Note\n\n**R-1.** The rule. Why: a reason.\n" });
	await markCompiled(vault, await out(vault, ["rev-parse", "HEAD"]));
	const compiled = await markerCommit(vault);
	await commitFiles(vault, change, "Change the note");
	await initRepo(join(project, "api"));
	const github = new FakeGitHub();
	const claude = fakeClaude(steps);
	const check: AgentSettings = {
		claudeCommand: claude.command,
		agent: "claude",
		permissionMode: "acceptEdits",
		allowedTools: "Bash(git *)",
		model: "haiku",
		effort: "low",
	};
	const options = (extra: Partial<CompileOptions> = {}): CompileOptions => ({
		share: async (report, snapshots) => {
			const moment = compileMoment(report);
			if (!moment) return;
			await shareReport({ vaultPath: vault, reports: [report], logPaths: { projectFolder: project, ...snapshots }, push: () => pushVault(vault) }, report, moment);
		},
		vaultPath: vault,
		projectFolder: project,
		claudeCommand: claude.command,
		agent: "claude",
		permissionMode: "acceptEdits",
		allowedTools: "Bash(git *)",
		model: "opus",
		effort: "high",
		author: "Test Author",
		githubProject: PROJECT_URL,
		github,
		// "Ask questions first" is on: the question pass runs with the Check row (CMP-105, CFG-47).
		questionPass: check,
		...extra,
	});
	return { root, vault, project, github, claude, options, compiled };
}

async function compile(options: CompileOptions): Promise<CompileReport> {
	return (await startCompile(options, () => {})).done;
}

const waitForCalls = async (claude: { calls: () => unknown[] }, n: number) => {
	while (claude.calls().length < n) await new Promise((resolve) => setTimeout(resolve, 20));
};

describe("the question pass (CMP-99, CMP-100)", () => {
	it("CMP-99: runs first with the Check row, in the model snapshot, with the diff and changed rules and no code", async () => {
		const s = await setup([{ answer: checked([], "some") }, { answer: plan([issue("api", "one")]) }], {
			"Note.md": "# Note\n\n**R-1.** The changed rule. Why: a reason.\n",
		});
		const report = await compile(s.options());
		const [pass, proper] = s.claude.calls();
		expect(s.claude.calls()).toHaveLength(2);
		// The pass: the Check row's model and effort, its own schema, in the model snapshot.
		expect(basename(pass.cwd)).toMatch(/^theory-model-/);
		expect(pass.args).toEqual(expect.arrayContaining(["--model", "haiku", "--effort", "low"]));
		expect(pass.args[pass.args.indexOf("--json-schema") + 1]).toBe(JSON.stringify(QUESTION_PASS_SCHEMA));
		expect(pass.prompt).toContain("You read only the model, never the code, and you plan nothing.");
		expect(pass.prompt).toContain("- R-1 (Note.md)");
		expect(pass.prompt).toContain("+**R-1.** The changed rule. Why: a reason.");
		expect(pass.prompt).not.toContain("theory-code-");
		expect(pass.prompt).not.toContain("## Rule map");
		// It can't read the code snapshot, and writes nowhere (CMP-104, INV-4, INV-14).
		expect(basename(proper.cwd)).toMatch(/^theory-code-/);
		expect(pass.args).toContain(`Read(//${proper.cwd.replace(/^\//, "")}/**)`);
		expect(pass.args).toContain(`Write(//${pass.cwd.replace(/^\//, "")}/**)`);
		expect(pass.args).toEqual(expect.arrayContaining(["--tools", "Read,Glob,Grep", "--permission-mode", "dontAsk"]));
		// CMP-100: with no questions, the compile proper starts at once, in the same report, with the Compile row.
		expect(proper.args).toEqual(expect.arrayContaining(["--model", "opus", "--effort", "high"]));
		expect(proper.prompt).toContain("You are compiling a theoretical model into a plan of work.");
		expect(report.status).toBe("succeeded");
		expect(report.issues?.map((i) => i.title)).toEqual(["Change one"]);
		expect(report.questionPass).toMatchObject({ state: "answered", changesCode: "some", why: "The rule changed.", model: "haiku", effort: "low" });
		expect(report.log).toContain("No questions about the model. Compiling.");
		expect(await markerCommit(s.vault)).toBe(report.toCommit);
	});

	it("CMP-105: runs no question pass when Ask questions first is off", async () => {
		const s = await setup([{ answer: plan([issue("api", "one")]) }]);
		const report = await compile(s.options({ questionPass: undefined }));
		expect(s.claude.calls()).toHaveLength(1);
		expect(s.claude.calls()[0].prompt).toContain("You are compiling a theoretical model into a plan of work.");
		expect(report.questionPass).toBeUndefined();
		expect(report.status).toBe("succeeded");
	});

	it("reads only an answer in the pass's shape: questions, and some or none with a sentence", () => {
		expect(readQuestionPassAnswer(checked([question("Which?")], "none", " Only wording. "))).toEqual({
			questions: [{ question: "Which?", notes: ["Note.md"], anchors: [{ path: "Note.md", heading: "Note", quote: "**R-1.** The rule." }] }],
			changesCode: "none",
			why: "Only wording.",
		});
		expect(readQuestionPassAnswer({ questions: [], changesCode: "maybe", why: "" })).toBeNull();
		expect(readQuestionPassAnswer({ questions: [], changesCode: "some" })).toBeNull();
		expect(readQuestionPassAnswer(plan([]))).toBeNull();
		// An ACP agent's answer is read with the pass's fields, which have no status or summary (AGT-10).
		expect(structuredAnswer(checked([]), QUESTION_PASS_SCHEMA.required)).not.toBeNull();
		expect(structuredAnswer({ questions: [] }, QUESTION_PASS_SCHEMA.required)).not.toBeNull();
		expect(structuredAnswer(checked([]))).toBeNull();
	});

	it("CMP-99: denies Claude Code every read of the folders it may not read", () => {
		const args = claudeArgs({
			settings: { claudeCommand: "claude", permissionMode: "acceptEdits", allowedTools: "", model: "", effort: "" },
			protectedPaths: ["/vault"],
			snapshot: "/tmp/theory-model-1",
			schema: QUESTION_PASS_SCHEMA,
			readOnly: true,
			unreadable: ["/tmp/theory-code-1"],
		});
		expect(args).toContain("Read(//tmp/theory-code-1/**)");
		expect(claudeArgs({ settings: { claudeCommand: "claude", permissionMode: "acceptEdits", allowedTools: "", model: "", effort: "" }, protectedPaths: [], snapshot: "/s", schema: QUESTION_PASS_SCHEMA, readOnly: true }).some((a) => a.startsWith("Read("))).toBe(false);
	});
});

describe("questions stop the compile (CMP-101, REP-55, HOOK-3)", () => {
	it("CMP-101: stops before the compile proper with status Questions, and the marker stays", async () => {
		const s = await setup([{ answer: checked([question("Which rule wins?"), question("What is a rule?")]) }, { answer: plan([issue("api", "one")]) }]);
		const report = await compile(s.options());
		expect(s.claude.calls()).toHaveLength(1);
		expect(report.status).toBe("questions");
		expect(report.questions.map((q) => q.question)).toEqual(["Which rule wins?", "What is a rule?"]);
		expect(report.questions[0].anchors).toEqual([{ path: "Note.md", heading: "Note", quote: "**R-1.** The rule." }]);
		expect(report.summary).toBe("Claude has 2 questions about the model. Answer them, commit, and compile again.");
		expect(report.issues).toBeUndefined();
		expect(s.github.calls.filter((c) => c.startsWith("createIssue"))).toEqual([]);
		// The marker doesn't move, so the revisions stay pending.
		expect(report.markerMoved).toBe(false);
		expect(await markerCommit(s.vault)).toBe(s.compiled);
		expect(await pendingRevisionCount(s.vault)).toBe(1);
		// The report is shared, since Claude ran, with the marker where it was (REP-46, REP-49).
		const shared = parseSharedReport(readFileSync(join(s.vault, report.shared!.file), "utf8"))!;
		expect(shared.status).toBe("questions");
		expect(shared.markerMoved).toBe(false);
		expect(shared.questionPass).toMatchObject({ state: "answered", changesCode: "some", model: "haiku" });
	});

	it("CMP-101: says how many questions, with the singular for one", () => {
		expect(questionsNotice(1)).toBe("Claude has 1 question about the model. Answer them, commit, and compile again.");
		expect(questionsNotice(3)).toBe("Claude has 3 questions about the model. Answer them, commit, and compile again.");
	});

	it("REP-55: the status line says Questions before compiling", () => {
		expect(STATUS_TEXT.questions).toBe("Questions before compiling");
	});

	it("HOOK-3: compile-end has status questions and lists the questions", async () => {
		const s = await setup([{ answer: checked([question("Which rule wins?")]) }]);
		const report = await compile(s.options());
		const details = compileEndDetails(report);
		expect(details.status).toBe("questions");
		expect(details.questions).toBe(1);
		expect(details.questionList).toEqual([{ question: "Which rule wins?", notes: ["Note.md"] }]);
		expect(details.issues).toEqual([]);
		// Other compiles' compile-end is as before.
		expect(compileEndDetails({ ...report, status: "succeeded" }).questionList).toBeUndefined();
	});

	it("a shared Questions report reads back as one, with its question pass", async () => {
		const s = await setup([{ answer: checked([question("Which rule wins?")], "none", "Only words.") }]);
		const report = await compile(s.options());
		const read = fromSharedReport(toSharedReport(report, [report]), report.shared!.file, s.project);
		expect(read.status).toBe("questions");
		expect(read.questionPass).toMatchObject({ state: "answered", changesCode: "none", why: "Only words.", model: "haiku", effort: "low" });
		expect(read.questions.map((q) => q.question)).toEqual(["Which rule wins?"]);
	});
});

describe("nothing the code must change (CMP-109, CMP-110)", () => {
	it("CMP-109: none for a wording-only change ends the compile as nothing to build, and the marker moves", async () => {
		const s = await setup([{ answer: checked([], "none", "Only the reason was reworded.") }, { answer: plan([issue("api", "one")]) }]);
		const report = await compile(s.options());
		expect(s.claude.calls()).toHaveLength(1);
		expect(report.status).toBe("succeeded");
		expect(report.issues).toEqual([]);
		expect(report.summary).toBe("Claude found nothing in these revisions that the code must change: Only the reason was reworded.");
		expect(report.summary).toBe(nothingToChangeText("Only the reason was reworded."));
		expect(report.questionPass?.skipped).toBe(true);
		expect(report.markerMoved).toBe(true);
		expect(await markerCommit(s.vault)).toBe(report.toCommit);
		expect(await pendingRevisionCount(s.vault)).toBe(0);
	});

	it("CMP-110: none is ignored when a rule changed before its Why:, and the compile proper runs", async () => {
		const s = await setup([{ answer: checked([], "none", "Nothing changes.") }, { answer: plan([issue("api", "one")]) }], {
			"Note.md": "# Note\n\n**R-1.** The other rule. Why: a reason.\n",
		});
		const report = await compile(s.options());
		expect(s.claude.calls()).toHaveLength(2);
		expect(report.questionPass?.skipped).toBeUndefined();
		expect(report.log).toContain(
			"No questions about the model. Claude found nothing the code must change, but more than the wording changed, so the compile reads the code.",
		);
		expect(report.issues?.map((i) => i.title)).toEqual(["Change one"]);
	});

	it("CMP-109: some for a wording-only change still runs the compile proper", async () => {
		const s = await setup([{ answer: checked([], "some") }, { answer: plan([]) }]);
		await compile(s.options());
		expect(s.claude.calls()).toHaveLength(2);
	});

	const diff = (before: string, after: string, oldPath: string | null = "Note.md", newPath: string | null = "Note.md") => {
		const lines = [
			`diff --git a/${oldPath ?? newPath} b/${newPath ?? oldPath}`,
			`--- ${oldPath ? `a/${oldPath}` : "/dev/null"}`,
			`+++ ${newPath ? `b/${newPath}` : "/dev/null"}`,
		];
		const a = before ? before.split("\n") : [];
		const b = after ? after.split("\n") : [];
		lines.push(`@@ -1,${a.length} +1,${b.length} @@`, ...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`));
		return parseModelDiff(lines.join("\n") + "\n").files;
	};
	const NOTE = "# Note\n\nAn introduction.\n\n**R-1.** The rule. Why: a reason.\n\n**R-2.** Another rule:\n- one\n- two\n\n## Next\n\nMore.";

	it("CMP-110: counts the reason after Why:, an introduction and text outside every rule as wording", () => {
		expect(wordingOnly(diff(NOTE, NOTE.replace("a reason.", "a better reason, said twice.")))).toBe(true);
		expect(wordingOnly(diff(NOTE, NOTE.replace("An introduction.", "A new introduction.")))).toBe(true);
		expect(wordingOnly(diff(NOTE, NOTE.replace("More.", "Much more.")))).toBe(true);
		// Adding a reason to a rule that had none keeps the rule's text.
		expect(wordingOnly(diff("**R-1.** The rule.", "**R-1.** The rule. Why: now with a reason."))).toBe(true);
		// A new note without rules.
		expect(wordingOnly(diff("", "# New\n\nJust words.", null, "New.md"))).toBe(true);
	});

	it("CMP-110: counts a rule changed before its Why:, a rule added or removed, and front matter as more than wording", () => {
		expect(wordingOnly(diff(NOTE, NOTE.replace("The rule.", "The new rule.")))).toBe(false);
		expect(wordingOnly(diff(NOTE, `${NOTE}\n\n**R-3.** A new rule.`))).toBe(false);
		expect(wordingOnly(diff(NOTE, NOTE.replace("**R-2.** Another rule:\n- one\n- two\n\n", "")))).toBe(false);
		expect(wordingOnly(diff(NOTE, NOTE.replace("**R-1.**", "**R-9.**")))).toBe(false);
		expect(wordingOnly(diff(`---\nrealized: false\n---\n${NOTE}`, NOTE))).toBe(false);
		// The list under a rule is part of it.
		expect(wordingOnly(diff(NOTE, NOTE.replace("- two", "- three")))).toBe(false);
		// With several Why:, only what comes after the last counts as the reason.
		const two = "**R-1.** The rule. Why: one. Also this. Why: two.";
		expect(wordingOnly(diff(two, two.replace("Also this.", "Also that.")))).toBe(false);
		expect(wordingOnly(diff(two, two.replace("two.", "three.")))).toBe(true);
	});

	it("CMP-110: counts a file that isn't a note, and a note renamed or moved, as more than wording", () => {
		expect(wordingOnly(diff("a", "b", "diagram.canvas", "diagram.canvas"))).toBe(false);
		const renamed = parseModelDiff("diff --git a/Note.md b/api/Note.md\nsimilarity index 100%\nrename from Note.md\nrename to api/Note.md\n").files;
		expect(wordingOnly(renamed)).toBe(false);
	});
});

describe("Compile anyway (CMP-102, REP-55)", () => {
	it("CMP-102: compiles the same revisions without a new question pass, and sends the questions along", async () => {
		const s = await setup([{ answer: checked([question("Which rule wins?")]) }, { answer: plan([issue("api", "one")]) }]);
		const stopped = await compile(s.options());
		expect(stopped.status).toBe("questions");
		// A revision committed since isn't part of it: Compile anyway compiles the stopped compile's revisions.
		await commitFiles(s.vault, { "Other.md": "# Other\n" }, "Add another note");
		const report = await compile(s.options({ compileAnyway: stopped }));
		expect(s.claude.calls()).toHaveLength(2);
		const prompt = s.claude.calls()[1].prompt;
		expect(basename(s.claude.calls()[1].cwd)).toMatch(/^theory-code-/);
		expect(prompt).toContain("## Questions already asked");
		expect(prompt).toContain("- Which rule wins? (Note.md)");
		expect(report.questionPass).toBeUndefined();
		expect(report.anywayOf).toBe(stopped.id);
		expect(report.fromCommit).toBe(stopped.fromCommit);
		expect(report.toCommit).toBe(stopped.toCommit);
		expect(report.revisions.map((r) => r.subject)).toEqual(["Change the note"]);
		expect(report.status).toBe("succeeded");
		expect(await markerCommit(s.vault)).toBe(stopped.toCommit);
		// The revision committed since stays pending.
		expect(await pendingRevisionCount(s.vault)).toBe(1);
	});

	it("CMP-109, CMP-102: compiles anyway after the pass ended the compile as nothing to build", async () => {
		const s = await setup([{ answer: checked([], "none", "Only words.") }, { answer: plan([issue("api", "one")]) }]);
		const skipped = await compile(s.options());
		expect(skipped.questionPass?.skipped).toBe(true);
		// Every revision is compiled, but Compile anyway still compiles the skipped ones.
		await expect(startCompile(s.options(), () => {})).rejects.toThrow("Every committed revision is already compiled.");
		const report = await compile(s.options({ compileAnyway: skipped }));
		expect(s.claude.calls()).toHaveLength(2);
		expect(s.claude.calls()[1].prompt).not.toContain("## Questions already asked");
		expect(report.issues?.map((i) => i.title)).toEqual(["Change one"]);
	});

	it("REP-55: is offered on a Questions report and after CMP-109, until a later compile moved the marker", () => {
		const base = { fromCommit: null, toCommit: "a", revisions: [], summary: "", changes: [], questions: [], problems: [], log: [] };
		const stopped: CompileReport = { ...base, id: "1", status: "questions", startedAt: "2026-11-28T10:00:00Z", markerMoved: false };
		const skipped: CompileReport = {
			...base,
			id: "2",
			status: "succeeded",
			startedAt: "2026-11-28T10:00:00Z",
			markerMoved: true,
			questionPass: { state: "answered", changesCode: "none", why: "Words.", skipped: true },
		};
		const plain: CompileReport = { ...base, id: "3", status: "succeeded", startedAt: "2026-11-28T10:00:00Z", markerMoved: true };
		expect(compileAnywayShown(stopped, [stopped])).toBe(true);
		expect(compileAnywayShown(skipped, [skipped])).toBe(true);
		expect(compileAnywayShown(plain, [plain])).toBe(false);
		expect(compileAnywayShown({ ...stopped, status: "failed" }, [])).toBe(false);
		// A later compile that didn't move the marker, like another Questions report, leaves it.
		const later = (markerMoved: boolean): CompileReport => ({ ...base, id: "9", status: "questions", startedAt: "2026-11-28T11:00:00Z", markerMoved });
		expect(compileAnywayShown(stopped, [stopped, later(false)])).toBe(true);
		expect(compileAnywayShown(stopped, [stopped, later(true)])).toBe(false);
		expect(compileAnywayShown(skipped, [skipped, later(true)])).toBe(false);
	});

	it("CMP-102: tells Claude the questions asked, and nothing when there were none", () => {
		expect(askedQuestionsText([])).toBe("");
		const text = askedQuestionsText([{ question: "Which?", notes: ["A.md", "B.md"] }, { question: "Why?", notes: [] }]);
		expect(text).toContain("The engineer chose to compile anyway, before answering them. Don't ask them again.");
		expect(text).toContain("- Which? (A.md, B.md)\n- Why?");
	});
});

describe("the question pass counts as a compile (CMP-104, UI-3)", () => {
	it("CMP-24, UI-3: shows Checking the model while it runs, and Cancel stops it with the marker in place", async () => {
		const s = await setup([{ hang: true }, { answer: plan([issue("api", "one")]) }]);
		const run = await startCompile(s.options(), () => {});
		await waitForCalls(s.claude, 1);
		expect(checkingModel(run.report)).toBe(true);
		run.cancel();
		const report = await run.done;
		expect(s.claude.calls()).toHaveLength(1);
		expect(report.status).toBe("cancelled");
		expect(report.questionPass?.state).toBe("cancelled");
		expect(checkingModel(report)).toBe(false);
		expect(report.shared).toBeUndefined();
		expect(await markerCommit(s.vault)).toBe(s.compiled);
	});

	it("UI-3: says Checking the model… only while the pass runs", () => {
		expect(CHECKING_LABEL).toBe("Checking the model…");
		expect(CHECKING_TOOLTIP).toBe("Claude is reading the model for questions before it reads the code.");
		expect(checkingModel({ status: "running", questionPass: { state: "running" } })).toBe(true);
		expect(checkingModel({ status: "running", questionPass: { state: "answered" } })).toBe(false);
		expect(checkingModel({ status: "running" })).toBe(false);
		expect(checkingModel(null)).toBe(false);
	});

	it("CMP-104: a pass with no answer fails the compile, and the marker stays", async () => {
		const s = await setup([{}, { answer: plan([issue("api", "one")]) }]);
		const report = await compile(s.options());
		expect(s.claude.calls()).toHaveLength(1);
		expect(report.status).toBe("failed");
		expect(report.questionPass?.state).toBe("failed");
		expect(report.problems.map((p) => p.text).join("\n")).toContain("Claude Code exited with code");
		expect(report.markerMoved).toBe(false);
		expect(await markerCommit(s.vault)).toBe(s.compiled);
	});

	it("CMP-104, INV-5: a pass that changes the model snapshot fails the compile before the code is read", async () => {
		const s = await setup([{ tamper: "Planted.md", answer: checked([]) }, { answer: plan([issue("api", "one")]) }]);
		const report = await compile(s.options());
		expect(s.claude.calls()).toHaveLength(1);
		expect(report.status).toBe("failed");
		expect(report.problems.map((p) => p.text)).toContain("Claude tried to change the model snapshot. Those changes were thrown away.");
		expect(await markerCommit(s.vault)).toBe(s.compiled);
	});

	it("CMP-19: a pass that can't start fails the compile, shares nothing and leaves the marker", async () => {
		const s = await setup([{ answer: checked([]) }]);
		const report = await compile(s.options({ questionPass: { ...s.options().questionPass!, claudeCommand: join(s.root, "missing-claude") } }));
		expect(report.status).toBe("failed");
		expect(report.summary).toBe("Claude Code couldn't be started.");
		expect(report.shared).toBeUndefined();
		expect(await markerCommit(s.vault)).toBe(s.compiled);
	});

	it("CMP-13: an ACP Check row needs its command before the compile starts", async () => {
		const s = await setup([]);
		await expect(startCompile(s.options({ questionPass: { ...s.options().questionPass!, agent: "acp", agentCommand: " " } }), () => {})).rejects.toThrow(
			"Set the Check row's agent command in theory.md settings first.",
		);
	});
});

describe("the question pass's tokens (REP-56, REP-57)", () => {
	it("count towards the compile's cost, each at its own model's price", async () => {
		const s = await setup([
			{ model: "claude-haiku-4-5", usage: { input_tokens: 1_000_000 }, answer: checked([], "some") },
			{ model: "claude-opus-5-5", usage: { input_tokens: 1_000_000 }, answer: plan([]) },
		]);
		const report = await compile(s.options());
		expect(report.questionPass?.tokens).toMatchObject({ input: 1_000_000, model: "claude-haiku-4-5" });
		expect(report.tokens).toMatchObject({ input: 1_000_000, model: "claude-opus-5-5" });
		const { compile: cost } = reportCosts(report);
		expect(cost.kind === "reported" && cost.models).toEqual(["claude-opus-5-5", "claude-haiku-4-5"]);
		// $4 for Opus 5.5's input and $1 for Haiku 4.5's.
		expect(cost.kind === "reported" && cost.dollars?.input).toBe(5);
	});

	it("show alone when the pass stopped the compile", () => {
		const report = {
			questionPass: { tokens: { input: 1_000_000, output: 0, cacheWrites: 0, cacheReads: 0, model: "claude-haiku-4-5" } },
		};
		const { compile: cost } = reportCosts(report);
		expect(cost.kind === "reported" && cost.dollars?.input).toBe(1);
	});
});

describe("the report's line for the pass", () => {
	it("says what the pass found when it let the compile proper run", () => {
		expect(questionPassLine({ state: "answered", changesCode: "some", why: "R-1 changed." })).toBe("Checked the model first. The code must change: R-1 changed.");
		expect(questionPassLine({ state: "answered", changesCode: "none", why: "Words." })).toBe(
			"Checked the model first. Claude found nothing the code must change: Words.",
		);
		expect(questionPassLine({ state: "answered", changesCode: "none", why: "Words.", skipped: true })).toBeNull();
		expect(questionPassLine({ state: "failed" })).toBeNull();
		expect(questionPassLine(undefined)).toBeNull();
	});
});
