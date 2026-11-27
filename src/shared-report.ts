import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { CompileReport, CompileStatus } from "./compile";
import type { CodeRead } from "./code-snapshot";
import { PUSH_REJECTED, type PushResult } from "./push";
import { recompiledBy } from "./recompile";
import { commit, git } from "./vault";

/** The dot folder at the vault root that holds the shared reports (REP-10). Never theory (INV-8, INV-13). */
export const COMPILES_FOLDER = ".compiles";
/** The version of the shared report's format (REP-45). */
export const SHARED_REPORT_VERSION = 1;

/** Who compiled or built: the name and email git signs with (CFG-34). */
export interface Person {
	name: string;
	email: string;
}

/** Where a compile's report is shared: its file in `.compiles/` and its short id (REP-44). */
export interface SharedPlace {
	/** The report's file, relative to the vault, like `.compiles/2026-11-28T09-14-03Z-k3f9a2.json`. */
	file: string;
	shortId: string;
}

/** One build of a compile, as the shared report keeps it (REP-45). */
export interface SharedBuild {
	builtBy: Person;
	startedAt: string;
	finishedAt: string | null;
	status: string;
	issues: { repo: string; number: number; state: string; branch: string | null; pullRequests: string[] }[];
}

/** The file in `.compiles/` (REP-45). Times are UTC in ISO 8601, revisions as full hashes. */
export interface SharedReport {
	version: number;
	id: string;
	compiledBy: Person;
	startedAt: string;
	finishedAt: string | null;
	agent: string;
	model: string | null;
	effort: string | null;
	from: string | null;
	to: string;
	markerMoved: boolean;
	status: Exclude<CompileStatus, "running">;
	/** Set while creating an issue failed and the compile waits for Retry or Discard (CMP-68). */
	issueFailure?: string;
	summary: string;
	problems: { problem: string; anchors: { path: string; heading?: string; quote?: string }[] }[];
	questions: { question: string; notes: string[]; anchors: { path: string; heading?: string; quote?: string }[] }[];
	revisions: { hash: string; author: string; date: string; subject: string }[];
	/** The code each repository was read at (REP-43). */
	code: CodeRead[];
	issues: {
		repo: string;
		number: number | null;
		kind: "epic" | "issue";
		title: string;
		rules: string[];
		shortName: string;
		url: string | null;
		/** For a recompile: the earlier issue this one continues (CMP-77). */
		continues: number | null;
	}[];
	/** For a recompile: the earlier report's file (REP-42). */
	recompileOf: string | null;
	/** For a recompiled compile: the newer report's file (REP-41). */
	recompiledBy: string | null;
	builds: SharedBuild[];
	/** Every pull request opened for this compile's work, by a build or by Create PR (REP-29). States stay in the data file. */
	pullRequests: { repo: string; branch: string; base: string; url: string }[];
}

/** A moment a shared report is committed at (REP-46), and only then. */
export type ShareMoment = "compile" | "update" | "recompile" | "build" | "pull-requests";

/** A new short id: six lowercase letters and digits, like `k3f9a2`. */
export function newShortId(): string {
	const bytes = randomBytes(6);
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

/** `.compiles/{UTC start, like 2026-11-28T09-14-03Z}-{short id}.json` (REP-44). */
export function sharedFileName(startedAt: string, shortId: string): string {
	const stamp = new Date(startedAt).toISOString().slice(0, 19).replace(/:/g, "-");
	return `${COMPILES_FOLDER}/${stamp}Z-${shortId}.json`;
}

/** The Activity log beside a report's file: the same name with `.activity.log` instead of `.json` (REP-44, REP-53). */
export function activityLogName(file: string): string {
	return file.replace(/\.json$/, ".activity.log");
}

/** The report's place in `.compiles/`, chosen the first time it is shared and kept after. */
export function sharedPlace(report: CompileReport): SharedPlace {
	if (!report.shared) {
		const shortId = newShortId();
		report.shared = { file: sharedFileName(report.startedAt, shortId), shortId };
	}
	return report.shared;
}

function utc(time: string | undefined): string | null {
	if (!time) return null;
	const date = new Date(time);
	return Number.isNaN(date.getTime()) ? time : date.toISOString();
}

function anchorsOf(anchors: { path: string; heading?: string; quote?: string }[] | undefined) {
	return (anchors ?? []).map((a) => ({ path: a.path, ...(a.heading ? { heading: a.heading } : {}), ...(a.quote ? { quote: a.quote } : {}) }));
}

/** Where a running report stands in its shared file: while it waits for Retry or Discard, it counts as failed so far. */
function sharedStatus(status: CompileStatus): Exclude<CompileStatus, "running"> {
	return status === "running" ? "failed" : status;
}

/** One build as the shared report keeps it (REP-45): who built it, when, and each issue's state, branch and pull requests. */
export function sharedBuild(report: CompileReport, builtBy: Person): SharedBuild | null {
	const build = report.build;
	if (!build) return null;
	return {
		builtBy,
		startedAt: utc(build.startedAt) ?? build.startedAt,
		finishedAt: utc(build.finishedAt),
		status: build.status,
		issues: (report.issues ?? [])
			.filter((i) => i.kind === "issue" && i.number !== undefined && !i.discarded)
			.map((i) => ({
				repo: i.repo,
				number: i.number as number,
				state: i.build ?? "waiting",
				branch: i.branch ?? null,
				pullRequests: (report.pullRequests ?? []).filter((pr) => pr.repo === i.repo && i.branch && pr.branch === i.branch).map((pr) => pr.url),
			})),
	};
}

/** The shared report of one compile (REP-45). `reports` resolves the files of the earlier and the newer report. */
export function toSharedReport(report: CompileReport, reports: CompileReport[]): SharedReport {
	const place = sharedPlace(report);
	// The other report is linked only once it is shared itself: a report only on this machine stays there (REP-51).
	const earlier = report.recompileOf ? reports.find((r) => r.id === report.recompileOf) : undefined;
	const newer = recompiledBy(report, reports);
	return {
		version: SHARED_REPORT_VERSION,
		id: place.shortId,
		compiledBy: { name: report.author ?? "", email: report.authorEmail ?? "" },
		startedAt: utc(report.startedAt) ?? report.startedAt,
		finishedAt: utc(report.finishedAt),
		agent: report.agent ?? "claude",
		model: report.model || null,
		effort: report.effort || null,
		from: report.fromCommit,
		to: report.toCommit,
		markerMoved: report.markerMoved === true,
		status: sharedStatus(report.status),
		...(report.issueFailure ? { issueFailure: report.issueFailure } : {}),
		summary: report.summary,
		problems: report.problems.map((p) => ({ problem: p.text, anchors: anchorsOf(p.anchors) })),
		questions: report.questions.map((q) => ({ question: q.question, notes: q.notes, anchors: anchorsOf(q.anchors) })),
		revisions: report.revisions.map((r) => ({ hash: r.hash, author: r.author, date: utc(r.date) ?? r.date, subject: r.subject })),
		code: report.code ?? [],
		issues: (report.issues ?? []).map((i) => ({
			repo: i.repo,
			number: i.number ?? null,
			kind: i.kind,
			title: i.title,
			rules: i.rules,
			shortName: i.shortName,
			url: i.url ?? null,
			continues: i.continued && i.number !== undefined ? i.number : null,
		})),
		recompileOf: earlier?.shared?.file ?? null,
		recompiledBy: newer?.shared?.file ?? null,
		builds: report.builds ?? [],
		pullRequests: (report.pullRequests ?? []).map((pr) => ({ repo: pr.repo, branch: pr.branch, base: pr.base, url: pr.url })),
	};
}

/** Two-space indents and a newline at the end, as comments are written (REP-45, CMNT-11). */
export function formatSharedReport(shared: SharedReport): string {
	return JSON.stringify(shared, null, 2) + "\n";
}

/** A shared report as read from its file, or null when the file can't be read as one (REP-52). */
export function parseSharedReport(text: string): SharedReport | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object") return null;
	const r = value as Partial<SharedReport>;
	if (typeof r.version !== "number" || typeof r.to !== "string" || typeof r.markerMoved !== "boolean") return null;
	if (r.from !== null && typeof r.from !== "string") return null;
	return r as SharedReport;
}

export type ReadShared = { kind: "none" } | { kind: "ok"; report: SharedReport } | { kind: "broken" };

/** Reads a shared report's file, relative to the vault, from the working tree. */
export async function readSharedReportFile(vaultPath: string, file: string): Promise<ReadShared> {
	const full = join(vaultPath, file);
	if (!existsSync(full)) return { kind: "none" };
	const report = parseSharedReport(await readFile(full, "utf8").catch(() => ""));
	return report ? { kind: "ok", report } : { kind: "broken" };
}

/** Paths the Activity log rewrites (REP-53): the project folder, both snapshots and the home folder. */
export interface LogPaths {
	projectFolder: string;
	/** The model snapshot. Its paths become `model/{path}`. */
	model?: string;
	/** The code snapshot, with one folder per repository like the project folder. */
	code?: string;
	/** The engineer's home folder. Unset means the real one. */
	home?: string;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every spelling of a folder a tool may log: as given, and on macOS with or without `/private`. */
function spellings(dir: string): string[] {
	const clean = dir.replace(/\/+$/, "");
	if (!clean) return [];
	if (clean.startsWith("/private/")) return [clean, clean.slice("/private".length)];
	if (/^\/(var|tmp)\//.test(clean)) return [`/private${clean}`, clean];
	return [clean];
}

/** Replaces `dir` and paths inside it with `label` (`""` for relative paths). */
function replaceFolder(line: string, dir: string | undefined, label: string): string {
	if (!dir) return line;
	for (const spelling of spellings(dir)) {
		const inside = new RegExp(`${escapeRegExp(spelling)}/`, "g");
		line = line.replace(inside, label ? `${label}/` : "");
		const itself = new RegExp(`${escapeRegExp(spelling)}(?![\\w.-])`, "g");
		line = line.replace(itself, label || ".");
	}
	return line;
}

/**
 * One Activity line as it is shared (REP-53): paths in the snapshots relative to them (the model snapshot's as
 * `model/…`), paths in the project folder relative to it, and any other path under the home folder starting with `~`.
 */
export function sharedLogLine(line: string, paths: LogPaths): string {
	let shared = replaceFolder(line, paths.model, "model");
	shared = replaceFolder(shared, paths.code, "");
	shared = replaceFolder(shared, paths.projectFolder, "");
	return replaceFolder(shared, paths.home ?? homedir(), "~");
}

/** The shared Activity log: plain text, one line per tool call, as the report shows it (REP-53). */
export function activityLogText(log: string[], paths: LogPaths): string {
	return log.map((line) => sharedLogLine(line, paths)).join("\n") + (log.length ? "\n" : "");
}

/** The commit message for a moment (REP-46). */
export function shareMessage(moment: ShareMoment, report: CompileReport, reports: CompileReport[] = []): string {
	const short = (hash: string | null) => (hash ? hash.slice(0, 7) : "start");
	switch (moment) {
		case "compile":
			return `Compile ${short(report.fromCommit)}..${short(report.toCommit)}`;
		case "update":
			return `Update compile ${sharedPlace(report).shortId}`;
		case "recompile": {
			const earlier = reports.find((r) => r.id === report.recompileOf);
			return `Recompile ${earlier?.shared?.shortId ?? sharedPlace(report).shortId}`;
		}
		case "build":
			return `Build compile ${sharedPlace(report).shortId}`;
		case "pull-requests":
			return `Open pull requests for compile ${sharedPlace(report).shortId}`;
	}
}

/**
 * The moment a compile's report is committed at, as it waits for Retry or Discard or once it ended (REP-46), or
 * null when it isn't shared: Claude never ran, or the compile was cancelled before it was shared (REP-10, CMP-23).
 */
export function compileMoment(report: CompileReport): ShareMoment | null {
	if (report.shared) return "update";
	if (report.markerMoved === undefined || report.status === "cancelled") return null;
	return report.recompileOf ? "recompile" : "compile";
}

export interface ShareContext {
	vaultPath: string;
	/** Every report, to resolve the earlier and newer report of a recompile. */
	reports: CompileReport[];
	/** The paths an Activity log rewrites. Needed only for the moments that write it. */
	logPaths?: LogPaths;
	/** Pushes the vault's `main` as every commit does (CMT-30, CMT-31). */
	push: () => Promise<PushResult>;
}

/**
 * How a share ended. `not-shared` is why the report stays only in the data file (REP-48). `local` is a report that
 * was never shared, like one from before shared reports: it stays only on this machine, and nothing is written.
 */
export type ShareResult = { kind: "shared"; hash: string | null } | { kind: "not-shared"; reason: string } | { kind: "local" };

/** The notice when a report couldn't be shared (REP-48). */
export function notSharedNotice(reason: string): string {
	return `Compile report saved but not shared: ${reason}`;
}

async function changedPaths(vaultPath: string, paths: string[]): Promise<boolean> {
	const { stdout } = await git(vaultPath, ["status", "--porcelain", "--untracked-files=all", "--", ...paths]);
	return stdout.trim() !== "";
}

/**
 * Writes the report's file (and for a moment that ends a compile, its Activity log, once) and commits only those,
 * signed by the engineer, then pushes (REP-46, CMT-31). A file in `.compiles/` that can't be read is never
 * overwritten (REP-52). When the commit or the push fails, the report stays in the data file and the next commit of
 * it carries the change (REP-48). Never throws.
 */
export async function shareReport(ctx: ShareContext, report: CompileReport, moment: ShareMoment): Promise<ShareResult> {
	// Only the moments that end a compile Claude ran start a shared report. A build or pull request of a report that
	// was never shared leaves it only on this machine (REP-10, REP-51).
	const starts = moment === "compile" || moment === "recompile";
	if (!starts && !report.shared) return { kind: "local" };
	const result = await shareReports(ctx, report, moment);
	const reports = moment === "recompile" ? [report, ...relatedReports(report, ctx.reports)] : [report];
	for (const r of reports) {
		if (result.kind === "shared") delete r.notShared;
		else if (result.kind === "not-shared") r.notShared = result.reason;
	}
	return result;
}

/**
 * For a recompile: the earlier report, which the same commit updates with the newer report's file (REP-46). Only
 * when it is shared already: a report only on this machine is never shared afterwards (REP-51).
 */
function relatedReports(report: CompileReport, reports: CompileReport[]): CompileReport[] {
	const earlier = reports.find((r) => r.id === report.recompileOf);
	return earlier && earlier !== report && earlier.shared ? [earlier] : [];
}

async function shareReports(ctx: ShareContext, report: CompileReport, moment: ShareMoment): Promise<ShareResult> {
	const { vaultPath } = ctx;
	const all = ctx.reports.includes(report) ? ctx.reports : [report, ...ctx.reports];
	const writes: { file: string; text: string; once?: boolean }[] = [];
	try {
		const reports = moment === "recompile" ? [report, ...relatedReports(report, all)] : [report];
		for (const r of reports) {
			const place = sharedPlace(r);
			writes.push({ file: place.file, text: formatSharedReport(toSharedReport(r, all)) });
		}
		// The Activity log is written once, when the compile ends after Claude ran, and never changed (REP-53).
		if (moment === "compile" || moment === "update" || moment === "recompile") {
			const log = activityLogName(sharedPlace(report).file);
			if (!existsSync(join(vaultPath, log)) && ctx.logPaths) {
				writes.push({ file: log, text: activityLogText(report.log, ctx.logPaths), once: true });
			}
		}
		for (const write of writes) {
			if (write.once) continue;
			if ((await readSharedReportFile(vaultPath, write.file)).kind === "broken") {
				return { kind: "not-shared", reason: `Can't read ${write.file}, so it wasn't overwritten.` };
			}
		}
		await mkdir(join(vaultPath, COMPILES_FOLDER), { recursive: true });
		for (const write of writes) await writeFile(join(vaultPath, write.file), write.text);
	} catch (error) {
		return { kind: "not-shared", reason: errorText(error) };
	}

	// The report's files, and nothing else. A log left uncommitted by a failed commit goes along (REP-48).
	const paths = writes.map((w) => w.file);
	const log = activityLogName(sharedPlace(report).file);
	if (!paths.includes(log) && existsSync(join(vaultPath, log))) paths.push(log);
	let hash: string | null = null;
	try {
		if (await changedPaths(vaultPath, paths)) hash = await commit(vaultPath, shareMessage(moment, report, all), paths);
	} catch (error) {
		return { kind: "not-shared", reason: errorText(error) };
	}
	const push = await ctx.push().catch((error): PushResult => ({ kind: "failed", message: errorText(error) }));
	if (push.kind === "rejected") return { kind: "not-shared", reason: `Couldn't push: ${PUSH_REJECTED}` };
	if (push.kind === "failed") return { kind: "not-shared", reason: `Couldn't push: ${push.message}` };
	return { kind: "shared", hash };
}

function errorText(error: unknown): string {
	return (error as { stderr?: string }).stderr?.trim() || (error instanceof Error ? error.message : String(error));
}

/** The shared reports committed at HEAD, by file. Files that can't be read are left out (REP-52). */
export async function committedSharedReports(vaultPath: string): Promise<Map<string, SharedReport>> {
	const found = new Map<string, SharedReport>();
	const names = await readdir(join(vaultPath, COMPILES_FOLDER)).catch(() => [] as string[]);
	const { stdout: status } = await git(vaultPath, ["status", "--porcelain", "-z", "--untracked-files=all", "--", COMPILES_FOLDER]).catch(() => ({
		stdout: "",
	}));
	const dirty = new Map<string, string>();
	for (const entry of status.split("\0")) if (entry) dirty.set(entry.slice(3), entry.slice(0, 2));
	// A file deleted from the working tree but still committed counts as committed.
	for (const [path, code] of dirty) {
		const name = path.slice(COMPILES_FOLDER.length + 1);
		if (code.includes("D") && path.startsWith(`${COMPILES_FOLDER}/`) && !names.includes(name)) names.push(name);
	}
	for (const name of names) {
		if (!name.endsWith(".json") || name.includes("/")) continue;
		const path = `${COMPILES_FOLDER}/${name}`;
		const code = dirty.get(path);
		let text: string | null;
		if (code === undefined) text = await readFile(join(vaultPath, path), "utf8").catch(() => null);
		else if (code === "??" || code.startsWith("A")) text = null; // Never committed: it doesn't count yet.
		else text = await git(vaultPath, ["show", `HEAD:${path}`]).then((r) => r.stdout, () => null);
		const report = text === null ? null : parseSharedReport(text);
		if (report) found.set(path, report);
	}
	return found;
}

/**
 * The last compile marker (REP-49, CMP-90): the `to` of the committed shared report with `markerMoved: true` whose
 * `to` comes last in the vault's history. Never a tag. Null when no shared report moved it.
 */
export async function markerCommit(vaultPath: string): Promise<string | null> {
	const reports = await committedSharedReports(vaultPath);
	const candidates = new Set<string>();
	for (const report of reports.values()) if (report.markerMoved && /^[0-9a-f]{40}$/.test(report.to)) candidates.add(report.to);
	if (candidates.size === 0) return null;
	const { stdout } = await git(vaultPath, ["rev-list", "--topo-order", "HEAD"]).catch(() => ({ stdout: "" }));
	for (const hash of stdout.split("\n")) if (candidates.has(hash)) return hash;
	return null;
}

/**
 * The vault files changed between the marker and HEAD, or null when no shared report moved the marker yet, so every
 * file is pending (REP-49, HDR-6).
 */
export async function filesSinceMarker(vaultPath: string): Promise<string[] | null> {
	const marker = await markerCommit(vaultPath);
	if (!marker) return null;
	const { stdout } = await git(vaultPath, ["diff", "--name-only", "-z", marker, "HEAD"]);
	return stdout.split("\0").filter(Boolean);
}

/**
 * The reports the data file keeps (REP-11): every shared one, and the newest 20 that aren't shared. A report whose
 * last commit or push failed isn't shared yet (REP-48).
 */
export function keptReports(reports: CompileReport[], max = 20): CompileReport[] {
	let unshared = 0;
	return reports.filter((r) => {
		if (r.shared && !r.notShared && r.status !== "running") return true;
		unshared++;
		return unshared <= max;
	});
}
