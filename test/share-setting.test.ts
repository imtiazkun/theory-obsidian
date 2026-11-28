import { existsSync, readFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import type { CompileReport } from "../src/compile";
import { pendingRevisionCount } from "../src/compile";
import { pushVault } from "../src/push";
import { ONLY_HERE, STATUS_TEXT, entryLabel, listReports } from "../src/report-list";
import {
	IMPORT_MESSAGE,
	MARKER_TAG,
	SHARE_OFF_QUESTION,
	filesSinceMarker,
	formatSharedReport,
	fromSharedReport,
	importMarker,
	importedReport,
	markerCommit,
	notSharedNotice,
	readSharedFolder,
	shareReport,
	shareToggleQuestion,
} from "../src/shared-report";
import { git } from "../src/vault";
import { commitFiles, initRepo, markCompiled, out, tempFolder, write } from "./helpers";

/** A vault with a bare `origin` and three revisions. */
async function vaultWithOrigin() {
	const root = tempFolder();
	const origin = join(root, "origin.git");
	const vault = join(root, "vault");
	await git(root, ["init", "--bare", "-b", "main", origin]);
	await initRepo(vault, { "Index.md": "1\n" });
	const first = await out(vault, ["rev-parse", "HEAD"]);
	const second = await commitFiles(vault, { "Index.md": "2\n" }, "Second");
	const third = await commitFiles(vault, { "Index.md": "3\n" }, "Third");
	await git(vault, ["remote", "add", "origin", origin]);
	await git(vault, ["push", "-q", "origin", "main"]);
	const head = () => out(vault, ["rev-parse", "HEAD"]);
	const tag = (path = vault) => out(path, ["rev-parse", `refs/tags/${MARKER_TAG}`]);
	return { root, origin, vault, first, second, third, head, tag };
}

function report(toCommit: string, extra: Partial<CompileReport> = {}): CompileReport {
	return {
		id: "1764321243000",
		status: "succeeded",
		startedAt: "2026-11-28T09:14:03.512Z",
		finishedAt: "2026-11-28T09:20:00.000Z",
		fromCommit: null,
		toCommit,
		revisions: [],
		summary: "Planned.",
		changes: [],
		questions: [],
		problems: [],
		log: ["Read: Index.md"],
		author: "Test Author",
		markerMoved: true,
		...extra,
	};
}

describe("Share compile reports off (CFG-44)", () => {
	it("asks before turning off, with the rule's words, and never before turning on", () => {
		expect(shareToggleQuestion(false)).toBe("Teammates won't see your compiles, and may compile the same revisions again. Turn off?");
		expect(shareToggleQuestion(false)).toBe(SHARE_OFF_QUESTION);
		expect(shareToggleQuestion(true)).toBeNull();
	});

	it("reads the marker from the local tag, and never from the shared reports", async () => {
		const v = await vaultWithOrigin();
		expect(await markerCommit(v.vault, false)).toBeNull();
		expect(await filesSinceMarker(v.vault, false)).toBeNull();
		// A shared report that moved the marker counts only while sharing is on.
		await markCompiled(v.vault, v.third);
		expect(await markerCommit(v.vault, false)).toBeNull();
		expect(await markerCommit(v.vault)).toBe(v.third);

		await git(v.vault, ["tag", MARKER_TAG, v.second]);
		expect(await markerCommit(v.vault, false)).toBe(v.second);
		expect(await markerCommit(v.vault, true)).toBe(v.third);
		expect((await filesSinceMarker(v.vault, false))?.sort()).toEqual([".compiles/2026-01-01T00-00-00Z-marker.json", "Index.md"]);
		// The shared report's own commit is in a dot folder, so only the third revision is pending.
		expect(await pendingRevisionCount(v.vault, false)).toBe(1);
		expect(await pendingRevisionCount(v.vault)).toBe(0);
	});

	it("writes no shared file and makes no commit, and a compile that ended moves the tag", async () => {
		const v = await vaultWithOrigin();
		const head = await v.head();
		const compiled = report(v.third);
		expect(await shareReport({ vaultPath: v.vault, reports: [compiled], push: () => pushVault(v.vault), sharing: false }, compiled, "compile")).toEqual({
			kind: "local",
		});
		expect(await v.tag()).toBe(v.third);
		expect(await markerCommit(v.vault, false)).toBe(v.third);
		expect(compiled.shared).toBeUndefined();
		expect(compiled.notShared).toBeUndefined();
		expect(existsSync(join(v.vault, ".compiles"))).toBe(false);
		expect(await v.head()).toBe(head);
		expect(await out(v.vault, ["status", "--porcelain"])).toBe("");
		// Nothing pushed, and never the tag (CMT-32).
		expect(await out(v.origin, ["rev-parse", "main"])).toBe(head);
		expect(await out(v.origin, ["tag", "--list"])).toBe("");
	});

	it("leaves the tag while issues wait for Retry or Discard, and after a Discard (CMP-68)", async () => {
		const v = await vaultWithOrigin();
		await git(v.vault, ["tag", MARKER_TAG, v.first]);
		const ctx = { vaultPath: v.vault, reports: [], push: () => pushVault(v.vault), sharing: false };
		const waiting = report(v.third, { status: "running", issueFailure: "Couldn't create the issues: HTTP 502" });
		await shareReport(ctx, waiting, "compile");
		expect(await v.tag()).toBe(v.first);
		waiting.status = "failed";
		waiting.markerMoved = false;
		await shareReport(ctx, waiting, "compile");
		expect(await v.tag()).toBe(v.first);
		// A failed compile Claude ran still moves it (CMP-22).
		await shareReport(ctx, report(v.second, { status: "failed" }), "compile");
		expect(await v.tag()).toBe(v.second);
	});

	it("keeps a build or pull requests of a report shared earlier in the data file, and never moves the tag for them", async () => {
		const v = await vaultWithOrigin();
		const shared = report(v.third);
		expect((await shareReport({ vaultPath: v.vault, reports: [shared], push: () => pushVault(v.vault) }, shared, "compile")).kind).toBe("shared");
		const head = await v.head();
		const file = readFileSync(join(v.vault, shared.shared!.file), "utf8");
		shared.build = { status: "finished", startedAt: "2026-11-28T10:00:00.000Z" };
		for (const moment of ["build", "pull-requests"] as const) {
			expect(await shareReport({ vaultPath: v.vault, reports: [shared], push: () => pushVault(v.vault), sharing: false }, shared, moment)).toEqual({
				kind: "local",
			});
		}
		expect(await v.head()).toBe(head);
		expect(readFileSync(join(v.vault, shared.shared!.file), "utf8")).toBe(file);
		expect(await markerCommit(v.vault, false)).toBeNull();
	});
});

describe("importing the old marker (CFG-45)", () => {
	it("writes one marker-only shared report from the tag, commits only it, pushes, and leaves the tag in place", async () => {
		const v = await vaultWithOrigin();
		await git(v.vault, ["tag", MARKER_TAG, v.second]);
		// Other work in the vault never goes along.
		write(v.vault, { "Draft.md": "draft\n" });
		const at = new Date("2026-11-28T09:14:03.512Z");
		const result = await importMarker({ vaultPath: v.vault, push: () => pushVault(v.vault), now: at });
		expect(result.kind).toBe("imported");
		if (result.kind !== "imported") return;

		expect(result.file).toMatch(/^\.compiles\/2026-11-28T09-14-03Z-[a-z0-9]{6}\.json$/);
		expect(await out(v.vault, ["log", "-1", "--format=%s"])).toBe("Share the compile marker");
		expect(IMPORT_MESSAGE).toBe("Share the compile marker");
		expect(await out(v.vault, ["rev-list", "--count", `${v.third}..HEAD`])).toBe("1");
		expect(await out(v.vault, ["show", "--name-only", "--format=", "HEAD"])).toBe(result.file);
		expect(await out(v.vault, ["log", "-1", "--format=%an <%ae>"])).toBe("Test Author <test@example.com>");
		expect(await out(v.vault, ["status", "--porcelain"])).toBe("?? Draft.md");
		expect(readdirSync(join(v.vault, ".compiles"))).toHaveLength(1);

		const shared = JSON.parse(readFileSync(join(v.vault, result.file), "utf8"));
		expect(shared).toMatchObject({
			from: v.second,
			to: v.second,
			markerMoved: true,
			status: "imported",
			summary: "Marker carried over from Test Author's machine",
			compiledBy: { name: "Test Author", email: "test@example.com" },
			startedAt: at.toISOString(),
			issues: [],
			revisions: [],
		});
		expect(readFileSync(join(v.vault, result.file), "utf8")).toBe(formatSharedReport(importedReport(v.second, shared.compiledBy, at, shared.id)));

		// The marker now comes from the shared report, and the tag is still where it was.
		expect(await markerCommit(v.vault)).toBe(v.second);
		expect(await v.tag()).toBe(v.second);
		expect(await out(v.origin, ["rev-parse", "main"])).toBe(await v.head());
		expect(await out(v.origin, ["tag", "--list"])).toBe("");
	});

	it("is shown as Imported, and reports already in the data file stay there, marked Only on this machine", async () => {
		const v = await vaultWithOrigin();
		await git(v.vault, ["tag", MARKER_TAG, v.second]);
		const result = await importMarker({ vaultPath: v.vault, push: () => pushVault(v.vault), now: new Date("2026-11-28T09:00:00Z") });
		expect(result.kind).toBe("imported");
		const local = report(v.second, { startedAt: "2026-11-27T09:00:00.000Z" });
		const entries = listReports([local], await readSharedFolder(v.vault), "/p");
		expect(entries).toHaveLength(2);
		const [imported, before] = entries;
		expect(imported.kind === "report" && imported.report.status).toBe("imported");
		expect(STATUS_TEXT.imported).toBe("Imported");
		expect(entryLabel(imported)).toContain("Imported · Test Author");
		expect(before).toMatchObject({ kind: "report", report: local, onlyHere: true });
		expect(entryLabel(before)).toContain(ONLY_HERE);
		expect(local.shared).toBeUndefined();
		const file = (await readSharedFolder(v.vault))[0];
		expect(file.kind === "ok" && fromSharedReport(file.report, file.file, "/p").summary).toBe("Marker carried over from Test Author's machine");
	});

	it("is skipped when a shared report moved the marker already, and when there is no tag", async () => {
		const v = await vaultWithOrigin();
		expect(await importMarker({ vaultPath: v.vault, push: () => pushVault(v.vault) })).toEqual({ kind: "skipped", reason: "no-tag" });
		expect(existsSync(join(v.vault, ".compiles"))).toBe(false);

		await git(v.vault, ["tag", MARKER_TAG, v.second]);
		await markCompiled(v.vault, v.third);
		const head = await v.head();
		expect(await importMarker({ vaultPath: v.vault, push: () => pushVault(v.vault) })).toEqual({ kind: "skipped", reason: "marker-shared" });
		expect(await v.head()).toBe(head);
		expect(readdirSync(join(v.vault, ".compiles"))).toEqual(["2026-01-01T00-00-00Z-marker.json"]);
		expect(await markerCommit(v.vault)).toBe(v.third);
		expect(await v.tag()).toBe(v.second);
	});

	it("still imports when the only shared reports didn't move the marker, like a Discard", async () => {
		const v = await vaultWithOrigin();
		await git(v.vault, ["tag", MARKER_TAG, v.second]);
		const discarded = { version: 1, id: "dddddd", from: v.first, to: v.third, markerMoved: false, status: "failed" };
		await commitFiles(v.vault, { ".compiles/2026-03-01T00-00-00Z-dddddd.json": JSON.stringify(discarded) }, "Update compile dddddd");
		expect((await importMarker({ vaultPath: v.vault, push: () => pushVault(v.vault) })).kind).toBe("imported");
		expect(await markerCommit(v.vault)).toBe(v.second);
	});

	it("leaves nothing behind when the commit fails, so the next load imports it", async () => {
		const v = await vaultWithOrigin();
		await git(v.vault, ["tag", MARKER_TAG, v.second]);
		const head = await v.head();
		// Git can't commit while another git holds the index.
		write(v.vault, { ".git/index.lock": "" });
		const failed = await importMarker({ vaultPath: v.vault, push: () => pushVault(v.vault) });
		expect(failed).toMatchObject({ kind: "not-shared", committed: false });
		expect(await v.head()).toBe(head);
		expect(readdirSync(join(v.vault, ".compiles"))).toEqual([]);

		rmSync(join(v.vault, ".git/index.lock"));
		expect((await importMarker({ vaultPath: v.vault, push: () => pushVault(v.vault) })).kind).toBe("imported");
		expect(readdirSync(join(v.vault, ".compiles"))).toHaveLength(1);
	});

	it("with two engineers' different tags, whoever pushes second gets the REP-48 notice, and the later to wins (REP-49)", async () => {
		const v = await vaultWithOrigin();
		const bo = join(v.root, "bo");
		await git(v.root, ["clone", "-q", v.origin, bo]);
		await git(v.vault, ["tag", MARKER_TAG, v.third]);
		await git(bo, ["tag", MARKER_TAG, v.second]);

		expect((await importMarker({ vaultPath: v.vault, push: () => pushVault(v.vault) })).kind).toBe("imported");
		const second = await importMarker({ vaultPath: bo, push: () => pushVault(bo) });
		expect(second).toMatchObject({ kind: "not-shared", committed: true });
		if (second.kind !== "not-shared") return;
		expect(notSharedNotice(second.reason)).toMatch(/^Compile report saved but not shared: Couldn't push/);
		// Bo's own import is committed locally, and counts until the pull.
		expect(await markerCommit(bo)).toBe(v.second);

		await git(bo, ["pull", "-q", "--rebase", "origin", "main"]);
		expect(readdirSync(join(bo, ".compiles"))).toHaveLength(2);
		expect(await markerCommit(bo)).toBe(v.third);
		expect(await v.tag(bo)).toBe(v.second);
	});
});
