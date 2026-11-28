import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import type { CompileReport } from "../src/compile";
import { pendingRevisionCount } from "../src/compile";
import { pushVault } from "../src/push";
import {
	activityLogName,
	activityLogText,
	compileMoment,
	filesSinceMarker,
	formatSharedReport,
	keptReports,
	markerCommit,
	newShortId,
	notSharedNotice,
	shareMessage,
	shareReport,
	sharedBuild,
	sharedFileName,
	sharedLogLine,
	toSharedReport,
} from "../src/shared-report";
import { git } from "../src/vault";
import { commitFiles, initRepo, markCompiled, out, tempFolder, write } from "./helpers";

const HOME = "/Users/ana";
const PROJECT = "/Users/ana/code/project";
const MODEL = "/private/var/folders/xy/T/theory-model-abc";
const CODE = "/private/var/folders/xy/T/theory-code-def";

function makeReport(extra: Partial<CompileReport> = {}): CompileReport {
	return {
		id: "1764321243000",
		status: "succeeded",
		startedAt: "2026-11-28T09:14:03.512Z",
		finishedAt: "2026-11-28T09:20:00.000Z",
		fromCommit: "a".repeat(40),
		toCommit: "b".repeat(40),
		revisions: [{ hash: "b".repeat(40), author: "Ana Lee", date: "2026-11-28T10:00:00+02:00", subject: "Write the rule" }],
		summary: "Planned.",
		changes: [],
		questions: [{ question: "Which one?", notes: ["app/Compile.md"], anchors: [{ path: "app/Compile.md", heading: "Marker" }] }],
		problems: [{ text: "Something.", anchors: [{ path: "app/Compile.md", quote: "The rule." }] }],
		log: [`Read: ${MODEL}/app/Compile.md`, `Grep: marker in ${CODE}/api`],
		author: "Ana Lee",
		authorEmail: "ana@example.com",
		model: "opus",
		effort: "",
		markerMoved: true,
		code: [{ repo: "api", branch: "main", commit: "c".repeat(40), source: "origin" }],
		issues: [
			{ kind: "issue", repo: "api", repoPath: "/p/api", title: "Add a thing", body: "B", rules: ["R-1"], shortName: "a-thing", number: 7, url: "https://github.com/team/api/issues/7" },
		],
		...extra,
	};
}

/** A vault with a bare `origin`, so shares push somewhere real. */
async function sharedVault() {
	const root = tempFolder();
	const origin = join(root, "origin.git");
	const vault = join(root, "vault");
	await git(root, ["init", "--bare", "-b", "main", origin]);
	await initRepo(vault, { "Index.md": "# Index\n" });
	await git(vault, ["remote", "add", "origin", origin]);
	await git(vault, ["push", "-q", "origin", "main"]);
	const ctx = (reports: CompileReport[] = []) => ({
		vaultPath: vault,
		reports,
		logPaths: { projectFolder: PROJECT, model: MODEL, code: CODE, home: HOME },
		push: () => pushVault(vault),
	});
	/** The files in a commit. */
	const filesIn = async (rev = "HEAD") => (await out(vault, ["show", "--name-only", "--format=", rev])).split("\n").filter(Boolean).sort();
	const subject = (rev = "HEAD") => out(vault, ["log", "-1", "--format=%s", rev]);
	return { root, origin, vault, ctx, filesIn, subject };
}

describe("the shared report's file (REP-44, REP-45)", () => {
	it("is named after the UTC start and a short id, with the Activity log beside it", () => {
		expect(sharedFileName("2026-11-28T09:14:03.512Z", "k3f9a2")).toBe(".compiles/2026-11-28T09-14-03Z-k3f9a2.json");
		// A start with an offset is written in UTC.
		expect(sharedFileName("2026-11-28T11:14:03+02:00", "k3f9a2")).toBe(".compiles/2026-11-28T09-14-03Z-k3f9a2.json");
		expect(activityLogName(".compiles/2026-11-28T09-14-03Z-k3f9a2.json")).toBe(".compiles/2026-11-28T09-14-03Z-k3f9a2.activity.log");
		expect(newShortId()).toMatch(/^[a-z0-9]{6}$/);
	});

	it("holds who compiled, the times, agent, range, marker, answer, revisions, code and issues, in UTC", () => {
		const report = makeReport({ shared: { file: ".compiles/2026-11-28T09-14-03Z-k3f9a2.json", shortId: "k3f9a2" } });
		const shared = toSharedReport(report, [report]);
		expect(shared).toEqual({
			version: 1,
			id: "k3f9a2",
			compiledBy: { name: "Ana Lee", email: "ana@example.com" },
			startedAt: "2026-11-28T09:14:03.512Z",
			finishedAt: "2026-11-28T09:20:00.000Z",
			agent: "claude",
			model: "opus",
			effort: null,
			from: "a".repeat(40),
			to: "b".repeat(40),
			markerMoved: true,
			status: "succeeded",
			summary: "Planned.",
			problems: [{ problem: "Something.", anchors: [{ path: "app/Compile.md", quote: "The rule." }] }],
			questions: [{ question: "Which one?", notes: ["app/Compile.md"], anchors: [{ path: "app/Compile.md", heading: "Marker" }] }],
			revisions: [{ hash: "b".repeat(40), author: "Ana Lee", date: "2026-11-28T08:00:00.000Z", subject: "Write the rule" }],
			code: [{ repo: "api", branch: "main", commit: "c".repeat(40), source: "origin" }],
			issues: [
				{ repo: "api", number: 7, kind: "issue", title: "Add a thing", rules: ["R-1"], shortName: "a-thing", url: "https://github.com/team/api/issues/7", continues: null },
			],
			recompileOf: null,
			recompiledBy: null,
			builds: [],
			pullRequests: [],
		});
		const text = formatSharedReport(shared);
		expect(text).toBe(JSON.stringify(shared, null, 2) + "\n");
		expect(text.split("\n")[1]).toBe('  "version": 1,');
	});

	it("links a recompile and the compile it recompiled by their files, and names what each issue continues (CMP-77)", () => {
		const earlier = makeReport({ id: "1", shared: { file: ".compiles/2026-11-27T08-00-00Z-old111.json", shortId: "old111" } });
		const recompile = makeReport({
			id: "2",
			startedAt: "2026-11-28T09:00:00.000Z",
			recompileOf: "1",
			issues: [{ ...makeReport().issues![0], continued: { title: "Add a thing", body: "B" } }],
		});
		const all = [recompile, earlier];
		const shared = toSharedReport(recompile, all);
		expect(shared.recompileOf).toBe(".compiles/2026-11-27T08-00-00Z-old111.json");
		expect(shared.issues[0].continues).toBe(7);
		expect(toSharedReport(earlier, all).recompiledBy).toBe(recompile.shared?.file);
		expect(recompile.shared?.file).toMatch(/^\.compiles\/2026-11-28T09-00-00Z-[a-z0-9]{6}\.json$/);
	});

	it("keeps each build: who built it, when, each issue's state, branch and pull requests", () => {
		const report = makeReport({
			build: { status: "finished", startedAt: "2026-11-28T10:00:00.000Z", finishedAt: "2026-11-28T10:30:00.000Z" },
			issues: [{ ...makeReport().issues![0], build: "built", branch: "theory/7-a-thing" }],
			pullRequests: [{ repo: "api", repoPath: "/p/api", branch: "theory/7-a-thing", base: "main", url: "https://github.com/team/api/pull/8", state: "open" }],
		});
		expect(sharedBuild(report, { name: "Bo", email: "bo@example.com" })).toEqual({
			builtBy: { name: "Bo", email: "bo@example.com" },
			startedAt: "2026-11-28T10:00:00.000Z",
			finishedAt: "2026-11-28T10:30:00.000Z",
			status: "finished",
			issues: [{ repo: "api", number: 7, state: "built", branch: "theory/7-a-thing", pullRequests: ["https://github.com/team/api/pull/8"] }],
		});
		// Pull request states stay in the data file (REP-10).
		expect(toSharedReport(report, [report]).pullRequests).toEqual([
			{ repo: "api", branch: "theory/7-a-thing", base: "main", url: "https://github.com/team/api/pull/8" },
		]);
	});
});

describe("the shared Activity log (REP-53)", () => {
	const paths = { projectFolder: PROJECT, model: MODEL, code: CODE, home: HOME };

	it("writes paths relative to the snapshots and the project folder, and others under home with ~", () => {
		expect(sharedLogLine(`Read: ${MODEL}/server/Waste entries.md`, paths)).toBe("Read: model/server/Waste entries.md");
		// macOS names the temp folder with or without /private.
		expect(sharedLogLine("Read: /var/folders/xy/T/theory-model-abc/server/Index.md", paths)).toBe("Read: model/server/Index.md");
		expect(sharedLogLine(`Read: ${CODE}/server/internal/waste.go`, paths)).toBe("Read: server/internal/waste.go");
		expect(sharedLogLine(`Read: ${PROJECT}/server/internal/waste.go`, paths)).toBe("Read: server/internal/waste.go");
		expect(sharedLogLine(`Glob: **/*.ts in ${CODE}`, paths)).toBe("Glob: **/*.ts in .");
		expect(sharedLogLine("Read: /Users/ana/notes/todo.md", paths)).toBe("Read: ~/notes/todo.md");
		expect(sharedLogLine("Read: /Users/anabel/x.md", paths)).toBe("Read: /Users/anabel/x.md");
		expect(sharedLogLine("Read: /etc/hosts", paths)).toBe("Read: /etc/hosts");
	});

	it("is plain text, one line per tool call", () => {
		expect(activityLogText([`Read: ${MODEL}/a.md`, "Denied: rm -rf x"], paths)).toBe("Read: model/a.md\nDenied: rm -rf x\n");
		expect(activityLogText([], paths)).toBe("");
	});
});

describe("committing shared reports (REP-46, CMT-31, CMT-32)", () => {
	it("says which moment a compile is at, and shares nothing Claude never ran or that was cancelled first (REP-10)", () => {
		expect(compileMoment(makeReport())).toBe("compile");
		expect(compileMoment(makeReport({ recompileOf: "1" }))).toBe("recompile");
		expect(compileMoment(makeReport({ markerMoved: undefined, status: "failed" }))).toBeNull();
		expect(compileMoment(makeReport({ markerMoved: undefined, status: "cancelled" }))).toBeNull();
		expect(compileMoment(makeReport({ markerMoved: false, status: "cancelled" }))).toBeNull();
		// Once shared, every later moment updates it.
		expect(compileMoment(makeReport({ status: "cancelled", markerMoved: false, shared: { file: ".compiles/x.json", shortId: "x" } }))).toBe("update");
	});

	it("names each moment's commit", () => {
		const report = makeReport({ shared: { file: ".compiles/x.json", shortId: "k3f9a2" } });
		expect(shareMessage("compile", report)).toBe("Compile aaaaaaa..bbbbbbb");
		expect(shareMessage("compile", makeReport({ fromCommit: null }))).toBe("Compile start..bbbbbbb");
		expect(shareMessage("update", report)).toBe("Update compile k3f9a2");
		expect(shareMessage("build", report)).toBe("Build compile k3f9a2");
		expect(shareMessage("pull-requests", report)).toBe("Open pull requests for compile k3f9a2");
		const earlier = makeReport({ id: "1", shared: { file: ".compiles/y.json", shortId: "old111" } });
		expect(shareMessage("recompile", makeReport({ id: "2", recompileOf: "1" }), [earlier])).toBe("Recompile old111");
	});

	it("commits the report and its Activity log at the end of a compile, only those, signed and pushed without tags", async () => {
		const v = await sharedVault();
		// Other work in the vault never goes along.
		write(v.vault, { "Index.md": "# Index\n\nEdited.\n", "Draft.md": "draft\n" });
		await git(v.vault, ["add", "Draft.md"]);
		await git(v.vault, ["tag", "theory/compiled"]);
		const report = makeReport();
		const result = await shareReport(v.ctx([report]), report, "compile");
		expect(result.kind).toBe("shared");
		const file = report.shared!.file;
		expect(await v.subject()).toBe("Compile aaaaaaa..bbbbbbb");
		expect(await v.filesIn()).toEqual([activityLogName(file), file].sort());
		expect(await out(v.vault, ["log", "-1", "--format=%an <%ae>"])).toBe("Test Author <test@example.com>");
		expect(await out(v.vault, ["diff", "--cached", "--name-only"])).toBe("Draft.md");
		expect(readFileSync(join(v.vault, "Index.md"), "utf8")).toBe("# Index\n\nEdited.\n");
		// Pushed, never with tags (CMT-32).
		expect(await out(v.origin, ["rev-parse", "main"])).toBe(await out(v.vault, ["rev-parse", "HEAD"]));
		expect(await out(v.origin, ["tag", "--list"])).toBe("");
		expect(readFileSync(join(v.vault, file), "utf8")).toBe(formatSharedReport(toSharedReport(report, [report])));
		expect(readFileSync(join(v.vault, activityLogName(file)), "utf8")).toBe("Read: model/app/Compile.md\nGrep: marker in api\n");
		expect(report.notShared).toBeUndefined();
	});

	it("updates it when issues are retried or discarded, and never changes the Activity log after", async () => {
		const v = await sharedVault();
		const report = makeReport({ status: "running", issueFailure: "Couldn't create the issues: HTTP 502" });
		await shareReport(v.ctx([report]), report, "compile");
		const file = report.shared!.file;
		expect(JSON.parse(readFileSync(join(v.vault, file), "utf8"))).toMatchObject({ status: "failed", issueFailure: "Couldn't create the issues: HTTP 502", markerMoved: true });
		const log = readFileSync(join(v.vault, activityLogName(file)), "utf8");

		report.log.push("Read: something new");
		delete report.issueFailure;
		report.status = "failed";
		report.markerMoved = false;
		await shareReport(v.ctx([report]), report, "update");
		expect(await v.subject()).toBe(`Update compile ${report.shared!.shortId}`);
		expect(await v.filesIn()).toEqual([file]);
		expect(readFileSync(join(v.vault, activityLogName(file)), "utf8")).toBe(log);
		expect(JSON.parse(readFileSync(join(v.vault, file), "utf8")).markerMoved).toBe(false);
	});

	it("commits both reports of a recompile in one commit", async () => {
		const v = await sharedVault();
		const earlier = makeReport({ id: "1", startedAt: "2026-11-27T08:00:00.000Z" });
		await shareReport(v.ctx([earlier]), earlier, "compile");
		const recompile = makeReport({ id: "2", recompileOf: "1", fromCommit: earlier.fromCommit });
		await shareReport(v.ctx([recompile, earlier]), recompile, "recompile");
		expect(await v.subject()).toBe(`Recompile ${earlier.shared!.shortId}`);
		expect(await v.filesIn()).toEqual([earlier.shared!.file, recompile.shared!.file, activityLogName(recompile.shared!.file)].sort());
		expect(JSON.parse(readFileSync(join(v.vault, earlier.shared!.file), "utf8")).recompiledBy).toBe(recompile.shared!.file);
		expect(JSON.parse(readFileSync(join(v.vault, recompile.shared!.file), "utf8")).recompileOf).toBe(earlier.shared!.file);
	});

	it("commits a build once it ended, and the pull requests Create PR opened, without moving the marker (CMP-43)", async () => {
		const v = await sharedVault();
		const report = makeReport({ toCommit: await out(v.vault, ["rev-parse", "HEAD"]) });
		await shareReport(v.ctx([report]), report, "compile");
		const marker = await markerCommit(v.vault);
		expect(marker).toBe(report.toCommit);

		report.build = { status: "finished", startedAt: "2026-11-28T10:00:00.000Z", finishedAt: "2026-11-28T10:30:00.000Z" };
		report.builds = [sharedBuild(report, { name: "Bo", email: "bo@example.com" })!];
		await shareReport(v.ctx([report]), report, "build");
		expect(await v.subject()).toBe(`Build compile ${report.shared!.shortId}`);
		expect(await v.filesIn()).toEqual([report.shared!.file]);

		report.pullRequests = [{ repo: "api", repoPath: "/p/api", branch: "theory/epic-1-x", base: "main", url: "https://github.com/team/api/pull/9", state: "open" }];
		await shareReport(v.ctx([report]), report, "pull-requests");
		expect(await v.subject()).toBe(`Open pull requests for compile ${report.shared!.shortId}`);
		expect(await v.filesIn()).toEqual([report.shared!.file]);
		expect(await out(v.origin, ["rev-parse", "main"])).toBe(await out(v.vault, ["rev-parse", "HEAD"]));
		expect(await markerCommit(v.vault)).toBe(marker);
	});

	it("keeps the report in the data file when the push fails, and the next commit carries it (REP-48)", async () => {
		const v = await sharedVault();
		// A teammate pushed first, so the push is rejected.
		const other = join(v.root, "other");
		await git(v.root, ["clone", "-q", v.origin, other]);
		await commitFiles(other, { "Other.md": "o\n" }, "Teammate's revision");
		await git(other, ["push", "-q", "origin", "main"]);

		const report = makeReport();
		const result = await shareReport(v.ctx([report]), report, "compile");
		expect(result).toEqual({ kind: "not-shared", reason: expect.stringContaining("Couldn't push") });
		expect(report.notShared).toContain("Couldn't push");
		expect(notSharedNotice("Couldn't push: x")).toBe("Compile report saved but not shared: Couldn't push: x");
		expect(keptReports([report], 0)).toEqual([]);
	});

	it("leaves the files on disk when the commit fails, and the next commit takes them along (REP-48)", async () => {
		const v = await sharedVault();
		const report = makeReport();
		expect((await shareReport(v.ctx([report]), report, "compile")).kind).toBe("shared");
		// Git can't commit while another git holds the index.
		write(v.vault, { ".git/index.lock": "" });
		report.markerMoved = false;
		const failed = await shareReport(v.ctx([report]), report, "update");
		expect(failed.kind).toBe("not-shared");
		expect(report.notShared).toBeDefined();
		expect(JSON.parse(readFileSync(join(v.vault, report.shared!.file), "utf8")).markerMoved).toBe(false);

		rmSync(join(v.vault, ".git/index.lock"));
		report.build = { status: "finished", startedAt: "2026-11-28T10:00:00.000Z" };
		expect((await shareReport(v.ctx([report]), report, "build")).kind).toBe("shared");
		expect(report.notShared).toBeUndefined();
		expect(await out(v.vault, ["status", "--porcelain", "--", ".compiles"])).toBe("");
		expect(JSON.parse(await out(v.vault, ["show", `HEAD:${report.shared!.file}`])).markerMoved).toBe(false);
	});

	it("leaves a report that was never shared only on this machine: a build, Create PR or update writes nothing (REP-51)", async () => {
		const v = await sharedVault();
		const head = await out(v.vault, ["rev-parse", "HEAD"]);
		// Like a report from before shared reports, kept in the data file.
		const report = makeReport({ markerMoved: undefined });
		for (const moment of ["build", "pull-requests", "update"] as const) {
			expect(await shareReport(v.ctx([report]), report, moment)).toEqual({ kind: "local" });
		}
		expect(report.shared).toBeUndefined();
		expect(report.notShared).toBeUndefined();
		expect(await out(v.vault, ["rev-parse", "HEAD"])).toBe(head);
		expect(existsSync(join(v.vault, ".compiles"))).toBe(false);
	});

	it("shares a recompile of a report only on this machine without sharing that report", async () => {
		const v = await sharedVault();
		const earlier = makeReport({ id: "1", startedAt: "2026-11-27T08:00:00.000Z" });
		const recompile = makeReport({ id: "2", recompileOf: "1" });
		expect((await shareReport(v.ctx([recompile, earlier]), recompile, "recompile")).kind).toBe("shared");
		expect(earlier.shared).toBeUndefined();
		expect(await v.subject()).toBe(`Recompile ${recompile.shared!.shortId}`);
		expect(await v.filesIn()).toEqual([recompile.shared!.file, activityLogName(recompile.shared!.file)].sort());
		expect(JSON.parse(readFileSync(join(v.vault, recompile.shared!.file), "utf8")).recompileOf).toBeNull();
		// Writing a report never gives another report a place in .compiles/.
		const other = makeReport({ id: "3" });
		toSharedReport(makeReport({ id: "4", recompileOf: "3" }), [other]);
		expect(other.shared).toBeUndefined();
	});

	it("never overwrites a file in .compiles/ it can't read (REP-52)", async () => {
		const v = await sharedVault();
		const report = makeReport({ shared: { file: ".compiles/2026-11-28T09-14-03Z-broken.json", shortId: "broken" } });
		write(v.vault, { [report.shared!.file]: "{ not json" });
		const head = await out(v.vault, ["rev-parse", "HEAD"]);
		const result = await shareReport(v.ctx([report]), report, "update");
		expect(result).toEqual({ kind: "not-shared", reason: `Can't read ${report.shared!.file}, so it wasn't overwritten.` });
		expect(readFileSync(join(v.vault, report.shared!.file), "utf8")).toBe("{ not json");
		expect(await out(v.vault, ["rev-parse", "HEAD"])).toBe(head);
	});
});

describe("the last compile marker (REP-49, CMP-22, CMP-90)", () => {
	it("is the to of the committed report with markerMoved whose to comes last in history, never a tag", async () => {
		const vault = tempFolder();
		await initRepo(vault, { "Index.md": "1\n" });
		const first = await out(vault, ["rev-parse", "HEAD"]);
		await git(vault, ["tag", "theory/compiled", first]);
		expect(await markerCommit(vault)).toBeNull();
		const second = await commitFiles(vault, { "Index.md": "2\n" }, "Second");
		const third = await commitFiles(vault, { "Index.md": "3\n" }, "Third");
		// Written out of order: the later file name doesn't decide, history does.
		await markCompiled(vault, third, second, "2026-01-01T00-00-00Z-aaaaaa");
		await markCompiled(vault, second, first, "2026-02-01T00-00-00Z-bbbbbb");
		expect(await markerCommit(vault)).toBe(third);
	});

	it("doesn't count a report with markerMoved false, like a Discard (CMP-68)", async () => {
		const vault = tempFolder();
		await initRepo(vault, { "Index.md": "1\n" });
		const first = await out(vault, ["rev-parse", "HEAD"]);
		await markCompiled(vault, first);
		const second = await commitFiles(vault, { "Index.md": "2\n" }, "Second");
		const discarded = { version: 1, id: "dddddd", from: first, to: second, markerMoved: false, status: "failed" };
		await commitFiles(vault, { ".compiles/2026-03-01T00-00-00Z-dddddd.json": JSON.stringify(discarded) }, "Update compile dddddd");
		expect(await markerCommit(vault)).toBe(first);
		expect(await pendingRevisionCount(vault)).toBe(1);
	});

	it("never counts a file it can't read (REP-52)", async () => {
		const vault = tempFolder();
		await initRepo(vault, { "Index.md": "1\n" });
		const first = await out(vault, ["rev-parse", "HEAD"]);
		await commitFiles(vault, { ".compiles/2026-01-01T00-00-00Z-broken.json": `{"to": "${first}", "markerMoved": true` }, "Broken");
		expect(await markerCommit(vault)).toBeNull();
	});

	it("moves when the report is written, before it is committed (CMP-22, REP-49)", async () => {
		const vault = tempFolder();
		await initRepo(vault, { "Index.md": "1\n" });
		const first = await out(vault, ["rev-parse", "HEAD"]);
		write(vault, { ".compiles/2026-01-02T00-00-00Z-local1.json": JSON.stringify({ version: 1, from: null, to: first, markerMoved: true }) });
		expect(await markerCommit(vault)).toBe(first);
		expect(await pendingRevisionCount(vault)).toBe(0);
		await git(vault, ["add", ".compiles"]);
		await git(vault, ["commit", "-q", "-m", "Compile"]);
		expect(await markerCommit(vault)).toBe(first);
	});

	it("doesn't move back when a committed report is deleted from the working tree", async () => {
		const vault = tempFolder();
		await initRepo(vault, { "Index.md": "1\n" });
		const first = await out(vault, ["rev-parse", "HEAD"]);
		await markCompiled(vault, first, null, "2026-01-01T00-00-00Z-gone11");
		rmSync(join(vault, ".compiles/2026-01-01T00-00-00Z-gone11.json"));
		expect(await markerCommit(vault)).toBe(first);
	});

	it("stays moved when the commit or the push fails, so the same revisions aren't planned twice (REP-48)", async () => {
		const v = await sharedVault();
		// Git can't commit while another git holds the index.
		const head = await out(v.vault, ["rev-parse", "HEAD"]);
		write(v.vault, { ".git/index.lock": "" });
		const report = makeReport({ toCommit: head });
		const result = await shareReport(v.ctx([report]), report, "compile");
		expect(result.kind).toBe("not-shared");
		expect(await markerCommit(v.vault)).toBe(report.toCommit);
		expect(await pendingRevisionCount(v.vault)).toBe(0);
		rmSync(join(v.vault, ".git/index.lock"));
	});

	it("sets which files are pending: those changed since the marker, or every file without one (HDR-6)", async () => {
		const vault = tempFolder();
		await initRepo(vault, { "Index.md": "1\n", "Other.md": "o\n" });
		expect(await filesSinceMarker(vault)).toBeNull();
		await markCompiled(vault, await out(vault, ["rev-parse", "HEAD"]));
		await commitFiles(vault, { "Index.md": "2\n" }, "Second");
		expect((await filesSinceMarker(vault))?.filter((f) => !f.startsWith(".compiles/"))).toEqual(["Index.md"]);
	});

	it("comes from a teammate's report with the pull, so the same revisions aren't compiled twice", async () => {
		const v = await sharedVault();
		const ana = join(v.root, "ana");
		await git(v.root, ["clone", "-q", v.origin, ana]);
		const revision = await commitFiles(ana, { "Note.md": "rule\n" }, "Write a rule");
		await markCompiled(ana, revision);
		await git(ana, ["push", "-q", "origin", "main"]);
		await git(v.vault, ["pull", "-q", "--ff-only", "origin", "main"]);
		expect(await markerCommit(v.vault)).toBe(revision);
		expect(await pendingRevisionCount(v.vault)).toBe(0);
		expect(existsSync(join(v.vault, ".compiles"))).toBe(true);
	});
});

describe("the reports the data file keeps (REP-11)", () => {
	it("keeps every shared report, and the newest reports that aren't shared up to the limit", () => {
		const shared = (id: string) => makeReport({ id, shared: { file: `.compiles/${id}.json`, shortId: id } });
		const local = (id: string) => makeReport({ id });
		const reports = [local("a"), shared("b"), local("c"), shared("d"), local("e"), { ...shared("f"), notShared: "Couldn't push" }];
		expect(keptReports(reports, 2).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
		// A running report is never shared yet.
		expect(keptReports([{ ...shared("g"), status: "running" }], 0)).toEqual([]);
	});
});
