import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import type { CompileReport } from "../src/compile";
import { pullVault } from "../src/pull";
import { pushVault } from "../src/push";
import {
	COMPILED_MEANWHILE,
	SOMEONE_ELSE_CHANGED,
	type SharedReport,
	changedOnRemote,
	compiledMeanwhile,
	formatSharedReport,
	fromSharedReport,
	shareReport,
} from "../src/shared-report";
import { git } from "../src/vault";
import { commitFiles, initRepo, out, tempFolder } from "./helpers";

const PROJECT = "/Users/bo/code/project";

function makeReport(extra: Partial<CompileReport> = {}): CompileReport {
	return {
		id: "1764321243000",
		status: "succeeded",
		startedAt: "2026-11-28T09:14:03.512Z",
		finishedAt: "2026-11-28T09:20:00.000Z",
		fromCommit: null,
		toCommit: "b".repeat(40),
		revisions: [],
		summary: "Planned.",
		changes: [],
		questions: [],
		problems: [],
		log: ["Read: Note.md"],
		author: "Bo Ek",
		authorEmail: "bo@example.com",
		markerMoved: true,
		issues: [
			{ kind: "issue", repo: "api", repoPath: "/p/api", title: "Add a thing", body: "B", rules: ["R-1"], shortName: "a-thing", number: 7, url: "https://github.com/team/api/issues/7" },
		],
		...extra,
	};
}

/** Two engineers' vaults, Bo's and Ana's, sharing one bare `origin`. */
async function team() {
	const root = tempFolder();
	const origin = join(root, "origin.git");
	const bo = join(root, "bo");
	const ana = join(root, "ana");
	await git(root, ["init", "--bare", "-b", "main", origin]);
	await initRepo(bo, { "Index.md": "# Index\n" });
	await git(bo, ["remote", "add", "origin", origin]);
	await git(bo, ["push", "-q", "origin", "main"]);
	await git(root, ["clone", "-q", origin, ana]);
	const ctx = (vault: string, reports: CompileReport[], pull = true) => ({
		vaultPath: vault,
		reports,
		projectFolder: PROJECT,
		push: () => pushVault(vault),
		...(pull ? { pull: () => pullVault(vault, "") } : {}),
	});
	const read = (vault: string, file: string) => JSON.parse(readFileSync(join(vault, file), "utf8")) as SharedReport;
	const sync = (vault: string) => git(vault, ["pull", "-q", "--ff-only", "origin", "main"]);
	return { root, origin, bo, ana, ctx, read, sync };
}

const build = (name: string, email: string, startedAt: string) => ({
	builtBy: { name, email },
	startedAt,
	finishedAt: startedAt,
	status: "finished",
	issues: [{ repo: "api", number: 7, state: "built", branch: "theory/7-a-thing", pullRequests: [] }],
});

describe("working on a teammate's shared report (REP-50)", () => {
	it("pulls first, and keeps the build a teammate shared before this one", async () => {
		const t = await team();
		const report = makeReport();
		expect((await shareReport(t.ctx(t.bo, [report]), report, "compile")).kind).toBe("shared");
		const file = report.shared!.file;

		// Ana builds from Bo's report on her machine and shares it.
		await t.sync(t.ana);
		const anas = fromSharedReport(t.read(t.ana, file), file, PROJECT);
		anas.builds = [build("Ana Lee", "ana@example.com", "2026-11-28T10:00:00.000Z")];
		expect((await shareReport(t.ctx(t.ana, [anas]), anas, "build")).kind).toBe("shared");

		// Bo builds later, without having pulled. The write pulls, takes in Ana's build, and adds his own.
		report.builds = [build("Bo Ek", "bo@example.com", "2026-11-28T11:00:00.000Z")];
		expect((await shareReport(t.ctx(t.bo, [report]), report, "build")).kind).toBe("shared");
		expect(t.read(t.bo, file).builds.map((b) => b.builtBy.name)).toEqual(["Ana Lee", "Bo Ek"]);
		await t.sync(t.ana);
		expect(t.read(t.ana, file).builds).toHaveLength(2);
	});

	it("writes nothing when the report changed on the remote and the vault can't fast-forward", async () => {
		const t = await team();
		const report = makeReport();
		await shareReport(t.ctx(t.bo, [report]), report, "compile");
		const file = report.shared!.file;
		await t.sync(t.ana);
		const anas = fromSharedReport(t.read(t.ana, file), file, PROJECT);
		anas.builds = [build("Ana Lee", "ana@example.com", "2026-11-28T10:00:00.000Z")];
		await shareReport(t.ctx(t.ana, [anas]), anas, "build");

		// Bo has a revision of his own that isn't pushed, so his vault can't fast-forward.
		await commitFiles(t.bo, { "Mine.md": "mine\n" }, "Bo's revision");
		const head = await out(t.bo, ["rev-parse", "HEAD"]);
		const before = readFileSync(join(t.bo, file), "utf8");
		report.builds = [build("Bo Ek", "bo@example.com", "2026-11-28T11:00:00.000Z")];
		const result = await shareReport(t.ctx(t.bo, [report]), report, "build");
		expect(result).toEqual({ kind: "refused", reason: SOMEONE_ELSE_CHANGED });
		expect(SOMEONE_ELSE_CHANGED).toBe("Someone else changed this compile. Pull with rebase in git, then try again.");
		expect(readFileSync(join(t.bo, file), "utf8")).toBe(before);
		expect(await out(t.bo, ["rev-parse", "HEAD"])).toBe(head);
		expect(await out(t.bo, ["status", "--porcelain"])).toBe("");
		// The data file keeps the build, and the next commit of the report carries it (REP-48).
		expect(report.notShared).toBe(SOMEONE_ELSE_CHANGED);
	});

	it("writes as usual when the vault can't fast-forward but nobody changed this report", async () => {
		const t = await team();
		const report = makeReport();
		await shareReport(t.ctx(t.bo, [report]), report, "compile");
		const file = report.shared!.file;
		await t.sync(t.ana);
		await commitFiles(t.ana, { "Hers.md": "hers\n" }, "Ana's revision");
		await git(t.ana, ["push", "-q", "origin", "main"]);
		await commitFiles(t.bo, { "Mine.md": "mine\n" }, "Bo's revision");

		expect(await git(t.bo, ["fetch", "-q", "origin"]).then(() => changedOnRemote(t.bo, [file]))).toBe(false);
		report.builds = [build("Bo Ek", "bo@example.com", "2026-11-28T11:00:00.000Z")];
		const result = await shareReport(t.ctx(t.bo, [report]), report, "build");
		// Committed here; the push waits for a pull with rebase (CMT-35).
		expect(result).toEqual({ kind: "not-shared", reason: expect.stringContaining("Couldn't push") });
		expect(await out(t.bo, ["log", "-1", "--format=%s"])).toBe(`Build compile ${report.shared!.shortId}`);
	});

	it("never pulls when there is no pull to run, like during a compile (PULL-4)", async () => {
		const t = await team();
		const report = makeReport();
		await shareReport(t.ctx(t.bo, [report]), report, "compile");
		await commitFiles(t.bo, { "Mine.md": "mine\n" }, "Bo's revision");
		report.builds = [build("Bo Ek", "bo@example.com", "2026-11-28T11:00:00.000Z")];
		const result = await shareReport({ ...t.ctx(t.bo, [report], false), pull: async () => null }, report, "build");
		expect(result.kind).toBe("shared");
	});
});

describe("two engineers compiling at once (CMP-91, CMP-3)", () => {
	/** Ana's compile of `from..to`, committed and pushed in `.compiles/`. */
	async function anaCompiled(t: Awaited<ReturnType<typeof team>>, from: string | null, to: string, markerMoved = true) {
		const shared = { version: 1, id: "ana111", to, from, markerMoved, status: "succeeded" } as SharedReport;
		await t.sync(t.ana);
		await commitFiles(t.ana, { ".compiles/2026-11-28T09-15-00Z-ana111.json": formatSharedReport(shared) }, "Compile ana");
		await git(t.ana, ["push", "-q", "origin", "main"]);
	}

	it("says so when the remote's newest report moved the marker past this compile's from, and keeps its issues", async () => {
		const t = await team();
		const start = await out(t.bo, ["rev-parse", "HEAD"]);
		const revision = await commitFiles(t.bo, { "Rule.md": "rule\n" }, "Write the rule");
		await git(t.bo, ["push", "-q", "origin", "main"]);
		await t.sync(t.ana);
		// Both compiled start..revision. Ana's report reached the remote first.
		await anaCompiled(t, start, revision);

		const report = makeReport({ fromCommit: start, toCommit: revision });
		const result = await shareReport(t.ctx(t.bo, [report]), report, "compile");
		expect(result.kind).toBe("not-shared");
		expect(report.compiledMeanwhile).toBe(".compiles/2026-11-28T09-15-00Z-ana111.json");
		expect(report.issues).toHaveLength(1);
		expect(COMPILED_MEANWHILE).toBe("Someone else compiled these revisions while you did. Check both reports before you build.");
	});

	it("counts a first compile against any marker on the remote", async () => {
		const t = await team();
		const revision = await out(t.bo, ["rev-parse", "HEAD"]);
		await anaCompiled(t, null, revision);
		const report = makeReport({ fromCommit: null, toCommit: revision });
		expect(await compiledMeanwhile(t.bo, report)).toBe(".compiles/2026-11-28T09-15-00Z-ana111.json");
	});

	it("says nothing when the remote moved for another reason, or its marker didn't move past from", async () => {
		const t = await team();
		const start = await out(t.bo, ["rev-parse", "HEAD"]);
		const revision = await commitFiles(t.bo, { "Rule.md": "rule\n" }, "Write the rule");
		await git(t.bo, ["push", "-q", "origin", "main"]);
		await t.sync(t.ana);
		await commitFiles(t.ana, { "Hers.md": "hers\n" }, "Ana's revision");
		await git(t.ana, ["push", "-q", "origin", "main"]);

		const report = makeReport({ fromCommit: start, toCommit: revision });
		expect((await shareReport(t.ctx(t.bo, [report]), report, "compile")).kind).toBe("not-shared");
		expect(report.compiledMeanwhile).toBeUndefined();

		// A report on the remote that didn't move the marker (a Discard) doesn't count, nor one at this compile's from.
		await anaCompiled(t, null, start, false);
		expect(await compiledMeanwhile(t.bo, report)).toBeNull();
		await anaCompiled(t, null, start, true);
		expect(await compiledMeanwhile(t.bo, report)).toBeNull();
	});
});
