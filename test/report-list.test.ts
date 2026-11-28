import { join } from "path";
import { describe, expect, it } from "vitest";
import type { CompileReport } from "../src/compile";
import { ONLY_HERE, absorbSharedFiles, entryId, entryLabel, listReports, listedReports } from "../src/report-list";
import {
	NO_ACTIVITY_LOG,
	type SharedFile,
	type SharedReport,
	absorbShared,
	fromSharedReport,
	readActivityLog,
	readSharedFolder,
	startedFromName,
	toSharedReport,
} from "../src/shared-report";
import { tempFolder, write } from "./helpers";

const PROJECT = "/Users/bo/code/project";

function local(extra: Partial<CompileReport> = {}): CompileReport {
	return {
		id: "100",
		status: "succeeded",
		startedAt: "2026-11-28T09:00:00.000Z",
		fromCommit: null,
		toCommit: "b".repeat(40),
		revisions: [],
		summary: "Mine.",
		changes: [],
		questions: [],
		problems: [],
		log: ["Read: Note.md"],
		author: "Bo Ek",
		authorEmail: "bo@example.com",
		...extra,
	};
}

/** A teammate's shared report, as the file in `.compiles/` holds it (REP-45). */
function teammate(extra: Partial<SharedReport> = {}): SharedReport {
	return {
		version: 1,
		id: "ana111",
		compiledBy: { name: "Ana Lee", email: "ana@example.com" },
		startedAt: "2026-11-28T10:00:00.000Z",
		finishedAt: "2026-11-28T10:05:00.000Z",
		agent: "claude",
		model: "opus",
		effort: null,
		from: "a".repeat(40),
		to: "c".repeat(40),
		markerMoved: true,
		status: "succeeded",
		summary: "Ana's plan.",
		problems: [{ problem: "Unclear.", anchors: [{ path: "app/Compile.md", quote: "The rule." }] }],
		questions: [{ question: "Which?", notes: ["app/Compile.md"], anchors: [] }],
		revisions: [{ hash: "c".repeat(40), author: "Ana Lee", date: "2026-11-28T09:59:00.000Z", subject: "Write it" }],
		code: [{ repo: "api", branch: "main", commit: "d".repeat(40), source: "origin" }],
		issues: [
			{ repo: "api", number: 1, kind: "epic", title: "Ship it", rules: ["R-1", "R-2"], shortName: "ship-it", url: "https://github.com/team/api/issues/1", continues: null },
			{ repo: "api", number: 2, kind: "issue", title: "Part one", rules: ["R-1"], shortName: "one", url: "https://github.com/team/api/issues/2", continues: null },
			{ repo: "api", number: 3, kind: "issue", title: "Part two", rules: ["R-2"], shortName: "two", url: "https://github.com/team/api/issues/3", continues: null },
		],
		recompileOf: null,
		recompiledBy: null,
		builds: [],
		pullRequests: [],
		...extra,
	};
}

const ANA_FILE = ".compiles/2026-11-28T10-00-00Z-ana111.json";
const ok = (file: string, report: SharedReport): SharedFile => ({ file, kind: "ok", report });

describe("listing shared reports with the data file's (REP-51, REP-52)", () => {
	it("lists both sources together, newest first, each shared report once", () => {
		const mine = local({ shared: { file: ".compiles/2026-11-28T09-00-00Z-bo2222.json", shortId: "bo2222" } });
		const older = local({ id: "50", startedAt: "2026-11-27T09:00:00.000Z" });
		const files = [
			ok(".compiles/2026-11-28T09-00-00Z-bo2222.json", toSharedReport(mine, [mine])),
			ok(ANA_FILE, teammate()),
			{ file: ".compiles/2026-11-28T11-00-00Z-bad333.json", kind: "broken" as const },
		];
		const entries = listReports([mine, older], files, PROJECT);
		expect(entries.map(entryId)).toEqual(["broken:.compiles/2026-11-28T11-00-00Z-bad333.json", ANA_FILE, "100", "50"]);
		// A shared report this machine has is listed as that report, never twice.
		expect(entries[2]).toEqual({ kind: "report", report: mine, onlyHere: false });
		expect(listedReports(entries).map((r) => r.id)).toEqual([ANA_FILE, "100", "50"]);
	});

	it("shows who compiled a shared report, and marks one only in the data file", () => {
		const mine = local({ shared: { file: ".compiles/x-bo2222.json", shortId: "bo2222" } });
		const notPushed = local({ id: "101", shared: { file: ".compiles/y-bo3333.json", shortId: "bo3333" }, notShared: "Couldn't push" });
		const neverShared = local({ id: "102", status: "cancelled" });
		const files = [ok(".compiles/x-bo2222.json", toSharedReport(mine, [mine])), ok(ANA_FILE, teammate())];
		const entries = listReports([mine, notPushed, neverShared], files, PROJECT);
		const label = (id: string) => entryLabel(entries.find((e) => entryId(e) === id)!);
		const when = (iso: string) => new Date(iso).toLocaleString();
		expect(label(ANA_FILE)).toBe(`${when("2026-11-28T10:00:00.000Z")} · Compiled · Ana Lee`);
		expect(label("100")).toBe(`${when("2026-11-28T09:00:00.000Z")} · Compiled · Bo Ek`);
		expect(label("101")).toBe(`${when("2026-11-28T09:00:00.000Z")} · Compiled · ${ONLY_HERE}`);
		expect(label("102")).toBe(`${when("2026-11-28T09:00:00.000Z")} · Cancelled · Only on this machine`);
	});

	it("marks a shared report whose file is gone from .compiles/ as only on this machine, once the folder was read", () => {
		const mine = local({ shared: { file: ".compiles/x-bo2222.json", shortId: "bo2222" } });
		expect(listReports([mine], null, PROJECT)[0]).toMatchObject({ onlyHere: false });
		expect(listReports([mine], [], PROJECT)[0]).toMatchObject({ onlyHere: true });
	});

	it("lists a file it can't read as \"Can't read {file}\", sorted by the start in its name", () => {
		const entries = listReports([local()], [{ file: ".compiles/2026-11-27T08-00-00Z-bad333.json", kind: "broken" }], PROJECT);
		expect(entries.map(entryLabel)[1]).toBe("Can't read .compiles/2026-11-27T08-00-00Z-bad333.json");
		expect(startedFromName(".compiles/2026-11-27T08-00-00Z-bad333.json")).toBe("2026-11-27T08:00:00.000Z");
		expect(startedFromName(".compiles/notes.json")).toBe("");
	});

	it("links a teammate's recompile to the report this machine has for the compile it recompiled", () => {
		const mine = local({ shared: { file: ".compiles/x-bo2222.json", shortId: "bo2222" } });
		const files = [ok(".compiles/x-bo2222.json", toSharedReport(mine, [mine])), ok(ANA_FILE, teammate({ recompileOf: ".compiles/x-bo2222.json" }))];
		const recompile = listedReports(listReports([mine], files, PROJECT)).find((r) => r.id === ANA_FILE);
		expect(recompile?.recompileOf).toBe("100");
	});

	it("keeps the pull request states asked of GitHub for a shared report across reads (REP-34)", () => {
		const pr = { repo: "api", branch: "theory/2-one", base: "theory/epic-1-ship-it", url: "https://github.com/team/api/pull/9" };
		const files = [ok(ANA_FILE, teammate({ pullRequests: [pr] }))];
		const first = listReports([], files, PROJECT);
		expect(listedReports(first)[0].pullRequests?.[0].state).toBe("open");
		listedReports(first)[0].pullRequests![0].state = "merged";
		const again = listedReports(listReports([], files, PROJECT, first))[0];
		expect(again).toBe(listedReports(first)[0]);
		// The folder read again gives new files: the state carries over to the new report.
		const reread = [ok(ANA_FILE, teammate({ pullRequests: [pr] }))];
		const fresh = listedReports(listReports([], reread, PROJECT, first))[0];
		expect(fresh).not.toBe(again);
		expect(fresh.pullRequests?.[0].state).toBe("merged");
	});
});

describe("reading .compiles/ (REP-52, REP-54)", () => {
	it("reads every report file, and names those it can't read", async () => {
		const vault = tempFolder();
		write(vault, {
			[ANA_FILE]: JSON.stringify(teammate(), null, 2) + "\n",
			".compiles/2026-11-28T11-00-00Z-bad333.json": "{ not json",
			".compiles/2026-11-28T12-00-00Z-old444.json": JSON.stringify({ hello: "world" }),
			".compiles/2026-11-28T10-00-00Z-ana111.activity.log": "Read: model/app/Compile.md\n",
		});
		const files = await readSharedFolder(vault);
		expect(files.map((f) => [f.file, f.kind])).toEqual([
			[ANA_FILE, "ok"],
			[".compiles/2026-11-28T11-00-00Z-bad333.json", "broken"],
			[".compiles/2026-11-28T12-00-00Z-old444.json", "broken"],
		]);
		expect(await readSharedFolder(join(vault, "missing"))).toEqual([]);
	});

	it("reads Activity from the shared log, and says so when none was shared", async () => {
		const vault = tempFolder();
		write(vault, { ".compiles/2026-11-28T10-00-00Z-ana111.activity.log": "Read: model/app/Compile.md\nGrep: marker in api\n" });
		expect(await readActivityLog(vault, ANA_FILE)).toEqual(["Read: model/app/Compile.md", "Grep: marker in api"]);
		expect(await readActivityLog(vault, ".compiles/2026-11-28T11-00-00Z-none00.json")).toBeNull();
		expect(NO_ACTIVITY_LOG).toBe("No activity log was shared for this compile.");
	});
});

describe("a report read from .compiles/ (REP-50)", () => {
	it("is a report the plugin can work on, which writes back the same file", () => {
		const shared = teammate({
			builds: [
				{
					builtBy: { name: "Ana Lee", email: "ana@example.com" },
					startedAt: "2026-11-28T11:00:00.000Z",
					finishedAt: "2026-11-28T11:30:00.000Z",
					status: "stopped",
					issues: [
						{ repo: "api", number: 2, state: "built", branch: "theory/2-one", pullRequests: ["https://github.com/team/api/pull/9"] },
						{ repo: "api", number: 3, state: "failed", branch: "theory/3-two", pullRequests: [] },
					],
				},
			],
			pullRequests: [{ repo: "api", branch: "theory/2-one", base: "theory/epic-1-ship-it", url: "https://github.com/team/api/pull/9" }],
		});
		const report = fromSharedReport(shared, ANA_FILE, PROJECT);
		expect(report).toMatchObject({
			id: ANA_FILE,
			fromShared: true,
			author: "Ana Lee",
			status: "succeeded",
			fromCommit: "a".repeat(40),
			toCommit: "c".repeat(40),
			log: [],
			problems: [{ text: "Unclear.", anchors: [{ path: "app/Compile.md", quote: "The rule." }] }],
			shared: { file: ANA_FILE, shortId: "ana111" },
		});
		const [epic, one, two] = report.issues ?? [];
		expect(epic).toMatchObject({ kind: "epic", number: 1, repoPath: join(PROJECT, "api"), body: "" });
		expect([one.build, one.branch, two.build, two.branch]).toEqual(["built", "theory/2-one", "failed", "theory/3-two"]);
		// The next build continues on the epic branch the first one made, so the epic never splits in two (BLD-27).
		expect(report.build).toEqual({
			status: "stopped",
			startedAt: "2026-11-28T11:00:00.000Z",
			finishedAt: "2026-11-28T11:30:00.000Z",
			epicBranches: [{ repo: "api", repoPath: join(PROJECT, "api"), branch: "theory/epic-1-ship-it", base: "main" }],
		});
		expect(report.pullRequests).toEqual([
			{ repo: "api", repoPath: join(PROJECT, "api"), branch: "theory/2-one", base: "theory/epic-1-ship-it", url: "https://github.com/team/api/pull/9", state: "open" },
		]);
		expect(toSharedReport(report, [report])).toEqual(shared);
	});

	it("keeps the links to reports this machine doesn't list", () => {
		const shared = teammate({ recompileOf: ".compiles/2026-11-01T00-00-00Z-gone00.json", recompiledBy: ".compiles/2026-12-01T00-00-00Z-new000.json" });
		const report = fromSharedReport(shared, ANA_FILE, PROJECT);
		expect(toSharedReport(report, [report])).toMatchObject({ recompileOf: shared.recompileOf, recompiledBy: shared.recompiledBy });
	});
});

describe("taking in what a teammate added to a shared report (REP-50)", () => {
	const myBuild = {
		builtBy: { name: "Bo Ek", email: "bo@example.com" },
		startedAt: "2026-11-28T11:00:00.000Z",
		finishedAt: "2026-11-28T11:10:00.000Z",
		status: "stopped",
		issues: [{ repo: "api", number: 2, state: "built", branch: "theory/2-one", pullRequests: [] }],
	};
	const anasBuild = {
		builtBy: { name: "Ana Lee", email: "ana@example.com" },
		startedAt: "2026-11-28T12:00:00.000Z",
		finishedAt: "2026-11-28T12:10:00.000Z",
		status: "finished",
		issues: [
			{ repo: "api", number: 2, state: "built", branch: "theory/2-one", pullRequests: [] },
			{ repo: "api", number: 3, state: "built", branch: "theory/3-two", pullRequests: ["https://github.com/team/api/pull/10"] },
		],
	};
	const mine = () => {
		const report = fromSharedReport(teammate({ builds: [myBuild] }), ANA_FILE, PROJECT);
		report.fromShared = undefined;
		report.pullRequests = [{ repo: "api", repoPath: "/p/api", branch: "theory/2-one", base: "x", url: "https://github.com/team/api/pull/9", state: "merged" }];
		return report;
	};

	it("keeps every build and pull request, and takes the newer build's issue states", () => {
		const report = mine();
		const pr = { repo: "api", branch: "theory/3-two", base: "theory/epic-1-ship-it", url: "https://github.com/team/api/pull/10" };
		absorbShared(report, teammate({ builds: [anasBuild], pullRequests: [pr] }), PROJECT);
		expect(report.builds?.map((b) => b.builtBy.name)).toEqual(["Bo Ek", "Ana Lee"]);
		expect(report.pullRequests?.map((p) => [p.url, p.state])).toEqual([
			["https://github.com/team/api/pull/9", "merged"],
			["https://github.com/team/api/pull/10", "open"],
		]);
		expect(report.issues?.map((i) => i.build)).toEqual([undefined, "built", "built"]);
		expect(report.build?.status).toBe("finished");
	});

	it("never takes an older build's states over this machine's, and leaves a running build alone", () => {
		const report = mine();
		report.build = { status: "finished", startedAt: "2026-11-28T13:00:00.000Z" };
		report.issues![2].build = "failed";
		absorbShared(report, teammate({ builds: [anasBuild] }), PROJECT);
		expect(report.issues![2].build).toBe("failed");
		expect(report.build.startedAt).toBe("2026-11-28T13:00:00.000Z");

		const running = mine();
		running.status = "running";
		running.shared = { file: ANA_FILE, shortId: "ana111" };
		const files = [ok(ANA_FILE, teammate({ builds: [anasBuild] }))];
		expect(absorbSharedFiles([running], files, PROJECT, null)).toBe(false);
		expect(running.builds).toHaveLength(1);
		const idle = mine();
		expect(absorbSharedFiles([idle], files, PROJECT, idle.id)).toBe(false);
		expect(absorbSharedFiles([idle], files, PROJECT, null)).toBe(true);
		expect(idle.builds).toHaveLength(2);
	});
});
