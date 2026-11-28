import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { BuildRecord, BuildStatus, EpicBranch } from "./build";
import type { CompileReport, CompileStatus } from "./compile";
import type { CodeRead } from "./code-snapshot";
import { type TokenUsage, readUsage } from "./costs";
import type { PullRequest } from "./github";
import type { BuildState, IssueRecord } from "./plan";
import { NO_PROMPT_ENV, type VaultPull } from "./pull";
import { PUSH_REJECTED, type PushResult } from "./push";
import { recompiledBy } from "./recompile";
import { commit, git, requireIdentity } from "./vault";

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
	/** The build's tokens in four parts, with the model that ran (REP-56). Absent when the agent reported none. */
	tokens?: TokenUsage;
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
	/**
	 * The compile's tokens in four parts, with the model that ran (REP-56), so teammates see its cost too (UI-16).
	 * Absent when the agent reported none, and in files written before REP-56.
	 */
	tokens?: TokenUsage;
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
		...(build.tokens ? { tokens: build.tokens } : {}),
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
		// An older report's single count has no parts, so it isn't shared (REP-56).
		...(readUsage(report.tokens) ? { tokens: readUsage(report.tokens) } : {}),
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
		// A link read from the file stays when this machine doesn't list the other report (REP-50).
		recompileOf: earlier?.shared?.file ?? report.sharedLinks?.recompileOf ?? null,
		recompiledBy: newer?.shared?.file ?? report.sharedLinks?.recompiledBy ?? null,
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
	/**
	 * Pulls the vault before writing to a report that is shared already (REP-50, PULL-7). Resolves to null when no
	 * pull ran, for example during a compile (PULL-4). Unset means no pull.
	 */
	pull?: () => Promise<VaultPull | null>;
	/** The project folder, for the repository paths of what a teammate added. Defaults to the one in `logPaths`. */
	projectFolder?: string;
	/**
	 * The Share compile reports setting (CFG-44). Off means nothing is written to `.compiles/`: the report stays in
	 * the data file, and a compile that moved the marker moves the local tag instead. Unset means on.
	 */
	sharing?: boolean;
}

/**
 * How a share ended. `not-shared` is why the report stays only in the data file (REP-48). `local` is a report that
 * was never shared, like one from before shared reports: it stays only on this machine, and nothing is written.
 */
export type ShareResult =
	| { kind: "shared"; hash: string | null }
	| { kind: "not-shared"; reason: string }
	/** Nothing was written: the report changed on the remote and the vault can't fast-forward (REP-50). */
	| { kind: "refused"; reason: string }
	| { kind: "local" };

/** What REP-50 says when a shared report changed on the remote and the vault can't fast-forward. */
export const SOMEONE_ELSE_CHANGED = "Someone else changed this compile. Pull with rebase in git, then try again.";

/** What the report says when a teammate compiled the same revisions at the same time (CMP-91). */
export const COMPILED_MEANWHILE = "Someone else compiled these revisions while you did. Check both reports before you build.";

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
	if (ctx.sharing === false) return keepOnThisMachine(ctx.vaultPath, report, moment);
	// Only the moments that end a compile Claude ran start a shared report. A build or pull request of a report that
	// was never shared leaves it only on this machine (REP-10, REP-51).
	const starts = moment === "compile" || moment === "recompile";
	if (!starts && !report.shared) return { kind: "local" };
	const result = await shareReports(ctx, report, moment);
	const reports = moment === "recompile" ? [report, ...relatedReports(report, ctx.reports)] : [report];
	for (const r of reports) {
		if (result.kind === "shared") delete r.notShared;
		else if (result.kind === "not-shared" || result.kind === "refused") r.notShared = result.reason;
	}
	return result;
}

/**
 * With Share compile reports off (CFG-44): nothing is written or committed, so the report stays in the data file. A
 * compile that ended and moved the marker moves the local tag `theory/compiled` to its `to`, as before shared reports.
 * While it waits for Retry or Discard the tag stays, so a Discard leaves it where it was (CMP-68). Never throws.
 */
export async function keepOnThisMachine(vaultPath: string, report: CompileReport, moment: ShareMoment): Promise<ShareResult> {
	const ended = moment === "compile" || moment === "update" || moment === "recompile";
	if (ended && report.status !== "running" && report.markerMoved === true && /^[0-9a-f]{40}$/.test(report.toCommit)) {
		await git(vaultPath, ["tag", "-f", MARKER_TAG, report.toCommit]).catch(() => {});
	}
	return { kind: "local" };
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
	const reports = moment === "recompile" ? [report, ...relatedReports(report, all)] : [report];
	// REP-50: a report shared already may have changed on another machine. Pull first, never write over what the vault
	// can't fast-forward to, and take in what a teammate added, so their build or pull requests aren't lost.
	const existing = reports.filter((r) => r.shared);
	if (existing.length > 0) {
		const files = existing.map((r) => sharedPlace(r).file);
		const pulled = ctx.pull ? await ctx.pull().catch(() => null) : null;
		if ((pulled?.kind === "diverged" || pulled?.kind === "waiting") && (await changedOnRemote(vaultPath, files))) {
			return { kind: "refused", reason: SOMEONE_ELSE_CHANGED };
		}
		const projectFolder = ctx.projectFolder ?? ctx.logPaths?.projectFolder ?? "";
		for (const r of existing) {
			const read = await readSharedReportFile(vaultPath, sharedPlace(r).file).catch((): ReadShared => ({ kind: "broken" }));
			if (read.kind === "ok") absorbShared(r, read.report, projectFolder);
		}
	}
	try {
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
	if (push.kind === "rejected") {
		// CMP-91: the remote moved while this compile ran. When a teammate's compile moved the marker past this one's
		// `from`, both plans cover the same revisions, and the engineers must decide. The compile keeps its issues.
		if (moment === "compile" || moment === "update" || moment === "recompile") {
			const other = await compiledMeanwhile(vaultPath, report).catch(() => null);
			if (other) report.compiledMeanwhile = other;
		}
		return { kind: "not-shared", reason: `Couldn't push: ${PUSH_REJECTED}` };
	}
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
 * The last compile marker. With Share compile reports on (REP-49, CMP-90): the `to` of the committed shared report
 * with `markerMoved: true` whose `to` comes last in the vault's history, never the tag. With it off (CFG-44): the
 * local tag `theory/compiled`, as before shared reports. Null when nothing moved it yet.
 */
export async function markerCommit(vaultPath: string, sharing = true): Promise<string | null> {
	if (!sharing) return tagMarker(vaultPath);
	return (await markerOf(vaultPath, await committedSharedReports(vaultPath), "HEAD"))?.to ?? null;
}

/** The local tag that is the marker while Share compile reports is off (CFG-44). It is never pushed (CMT-32). */
export const MARKER_TAG = "theory/compiled";

/** The commit the local tag `theory/compiled` points at, or null when there is no such tag. */
export async function tagMarker(vaultPath: string): Promise<string | null> {
	try {
		const { stdout } = await git(vaultPath, ["rev-parse", "--verify", "--quiet", `refs/tags/${MARKER_TAG}^{commit}`]);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

/** The report among `reports` that sets the marker at `rev` (REP-49): markerMoved, and its `to` last in `rev`'s history. */
async function markerOf(vaultPath: string, reports: Map<string, SharedReport>, rev: string): Promise<{ file: string; to: string } | null> {
	const candidates = new Map<string, string>();
	for (const [file, report] of reports) if (report.markerMoved && /^[0-9a-f]{40}$/.test(report.to)) candidates.set(report.to, file);
	if (candidates.size === 0) return null;
	const { stdout } = await git(vaultPath, ["rev-list", "--topo-order", rev]).catch(() => ({ stdout: "" }));
	for (const hash of stdout.split("\n")) {
		const file = candidates.get(hash);
		if (file) return { file, to: hash };
	}
	return null;
}

const REMOTE_MAIN = "refs/remotes/origin/main";

/** The shared reports in `.compiles/` at a revision, like `origin/main`, by file. Files that can't be read are left out (REP-52). */
async function sharedReportsAt(vaultPath: string, rev: string): Promise<Map<string, SharedReport>> {
	const found = new Map<string, SharedReport>();
	const { stdout } = await git(vaultPath, ["ls-tree", "-z", "--name-only", rev, `${COMPILES_FOLDER}/`]).catch(() => ({ stdout: "" }));
	for (const path of stdout.split("\0")) {
		if (!path.endsWith(".json") || path.slice(COMPILES_FOLDER.length + 1).includes("/")) continue;
		const text = await git(vaultPath, ["show", `${rev}:${path}`]).then((r) => r.stdout, () => null);
		const report = text === null ? null : parseSharedReport(text);
		if (report) found.set(path, report);
	}
	return found;
}

/**
 * True when any of these files changed on `origin/main` since the vault and the remote parted, as the last fetch
 * saw it (REP-50). False when the remote has no `main`.
 */
export async function changedOnRemote(vaultPath: string, files: string[]): Promise<boolean> {
	const base = await git(vaultPath, ["merge-base", "refs/heads/main", REMOTE_MAIN]).then((r) => r.stdout.trim(), () => null);
	if (!base) return false;
	const { stdout } = await git(vaultPath, ["diff", "--name-only", base, REMOTE_MAIN, "--", ...files]);
	return stdout.trim() !== "";
}

/**
 * After this compile's shared report couldn't be pushed because the remote moved (CMP-91): fetches the remote, and
 * when its newest report moved the marker past this compile's `from` (onto a descendant of it, or anywhere when this
 * was the first compile), returns that report's file. Null otherwise, or when the remote can't be reached.
 */
export async function compiledMeanwhile(vaultPath: string, report: CompileReport): Promise<string | null> {
	await git(vaultPath, ["fetch", "--quiet", "--no-tags", "origin"], NO_PROMPT_ENV);
	const remote = await markerOf(vaultPath, await sharedReportsAt(vaultPath, REMOTE_MAIN), REMOTE_MAIN);
	if (!remote || remote.file === report.shared?.file || remote.to === report.fromCommit) return null;
	if (report.fromCommit) {
		const past = await git(vaultPath, ["merge-base", "--is-ancestor", report.fromCommit, remote.to]).then(() => true, () => false);
		if (!past) return null;
	}
	return remote.file;
}

/**
 * The vault files changed between the marker and HEAD, or null when nothing moved the marker yet, so every file is
 * pending (REP-49, HDR-6). `sharing` is the Share compile reports setting, which says where the marker is (CFG-44).
 */
export async function filesSinceMarker(vaultPath: string, sharing = true): Promise<string[] | null> {
	const marker = await markerCommit(vaultPath, sharing);
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

/** What Activity says for a report from `.compiles/` whose log file is missing or can't be read (REP-54). */
export const NO_ACTIVITY_LOG = "No activity log was shared for this compile.";

/** A file in `.compiles/`: a report the plugin can read, or one it can't (REP-52). */
export type SharedFile = { file: string; kind: "ok"; report: SharedReport } | { file: string; kind: "broken" };

/** Every report file in `.compiles/`, as the working tree has it, sorted by name (REP-44, REP-51, REP-52). */
export async function readSharedFolder(vaultPath: string): Promise<SharedFile[]> {
	const names = await readdir(join(vaultPath, COMPILES_FOLDER)).catch(() => [] as string[]);
	const files: SharedFile[] = [];
	for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
		const file = `${COMPILES_FOLDER}/${name}`;
		const read = await readSharedReportFile(vaultPath, file).catch((): ReadShared => ({ kind: "broken" }));
		if (read.kind === "ok") files.push({ file, kind: "ok", report: read.report });
		else if (read.kind === "broken") files.push({ file, kind: "broken" });
	}
	return files;
}

/** The lines of a shared report's Activity log (REP-53, REP-54), or null when the file is missing or can't be read. */
export async function readActivityLog(vaultPath: string, file: string): Promise<string[] | null> {
	const text = await readFile(join(vaultPath, activityLogName(file)), "utf8").catch(() => null);
	if (text === null) return null;
	return text.split("\n").filter((line, i, lines) => line !== "" || i < lines.length - 1);
}

/** When a compile started, from its file's name (REP-44), as ISO 8601; "" when the name doesn't say. */
export function startedFromName(file: string): string {
	const match = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z-[^/]*\.json$/.exec(file);
	return match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}.000Z` : "";
}

function list<T>(value: T[] | undefined | null): T[] {
	return Array.isArray(value) ? value : [];
}

function time(value: string | undefined | null): number {
	const ms = value ? Date.parse(value) : NaN;
	return Number.isNaN(ms) ? -Infinity : ms;
}

const BUILD_STATES: BuildState[] = ["waiting", "building", "built", "skipped", "failed"];
const BUILD_STATUSES: BuildStatus[] = ["finished", "stopped", "cancelled"];

/**
 * The epic branches a build made, as far as the shared report tells (BLD-11, BLD-15): the base of a sub-issue's pull
 * request, else the epic branch's name. Their base is the default branch the compile read the code at (REP-43).
 */
function sharedEpicBranches(report: CompileReport, repoPath: (repo: string) => string): EpicBranch[] | undefined {
	const issues = report.issues ?? [];
	const epic = issues.find((i) => i.kind === "epic" && i.number !== undefined);
	if (!epic) return undefined;
	const subs = issues.filter((i) => i.kind === "issue" && i.number !== undefined);
	const merged = (report.pullRequests ?? []).find((pr) => subs.some((i) => i.repo === pr.repo && i.branch === pr.branch));
	const branch = merged?.base ?? `theory/epic-${epic.number}-${epic.shortName}`;
	const repos = [...new Set(subs.map((i) => i.repo))];
	return repos.map((repo) => {
		const read = report.code?.find((c) => c.repo === repo)?.branch;
		const opened = (report.pullRequests ?? []).find((pr) => pr.repo === repo && pr.branch === branch)?.base;
		return { repo, repoPath: repoPath(repo), branch, base: opened ?? read ?? "" };
	});
}

/** Takes one build from the shared report as the report's latest build: its status, times and each issue's state. */
function applySharedBuild(report: CompileReport, build: SharedBuild, repoPath: (repo: string) => string) {
	for (const entry of list(build.issues)) {
		const issue = report.issues?.find((i) => i.kind === "issue" && i.repo === entry.repo && i.number === entry.number);
		if (!issue) continue;
		if (BUILD_STATES.includes(entry.state as BuildState)) issue.build = entry.state as BuildState;
		if (entry.branch) issue.branch = entry.branch;
	}
	// A build that ended elsewhere isn't running here (REP-47).
	const status = BUILD_STATUSES.includes(build.status as BuildStatus) ? (build.status as BuildStatus) : "stopped";
	const record: BuildRecord = { status, startedAt: build.startedAt, ...(build.finishedAt ? { finishedAt: build.finishedAt } : {}) };
	const epicBranches = sharedEpicBranches(report, repoPath);
	if (epicBranches) record.epicBranches = epicBranches;
	report.build = record;
}

/**
 * Takes in what the shared report's file holds that this machine may not know yet, because another engineer built
 * from it or opened its pull requests (REP-50): every build, every pull request, and the newest build's issue states
 * when it is newer than this machine's. Nothing this machine knows is dropped, and a build running here is left alone.
 */
export function absorbShared(report: CompileReport, shared: SharedReport, projectFolder: string): void {
	const repoPath = (repo: string) => report.issues?.find((i) => i.repo === repo)?.repoPath ?? join(projectFolder, repo);
	const key = (b: SharedBuild) => `${b.builtBy?.email ?? ""}\u0000${b.startedAt}`;
	const builds = [...(report.builds ?? [])];
	for (const build of list(shared.builds)) if (!builds.some((b) => key(b) === key(build))) builds.push(build);
	builds.sort((a, b) => time(a.startedAt) - time(b.startedAt));
	if (builds.length > 0) report.builds = builds;

	const pullRequests: PullRequest[] = report.pullRequests ?? [];
	for (const pr of list(shared.pullRequests)) {
		if (pullRequests.some((p) => p.url === pr.url)) continue;
		// Its state is asked of GitHub as REP-34 says. Until then it counts as open.
		pullRequests.push({ repoPath: repoPath(pr.repo), repo: pr.repo, branch: pr.branch, base: pr.base, url: pr.url, state: "open" });
	}
	if (pullRequests.length > 0) report.pullRequests = pullRequests;

	const latest = builds[builds.length - 1];
	if (latest && report.build?.status !== "running" && time(latest.startedAt) > time(report.build?.startedAt)) {
		applySharedBuild(report, latest, repoPath);
	}
	report.sharedLinks = { recompileOf: shared.recompileOf ?? null, recompiledBy: shared.recompiledBy ?? null };
}

/**
 * A report from `.compiles/` as the plugin shows and works with it (REP-51, REP-50). Its id is its file. The issue
 * bodies aren't shared, so they are empty until a build or recompile reads them from GitHub. A recompile's
 * `recompileOf` is the earlier report's file, which `listReports` turns into the id this machine knows it by.
 */
export function fromSharedReport(shared: SharedReport, file: string, projectFolder: string): CompileReport {
	const status = (["succeeded", "failed", "cancelled", "imported"] as const).find((s) => s === shared.status) ?? "failed";
	const issues: IssueRecord[] = list(shared.issues).map((i) => ({
		kind: i.kind === "epic" ? "epic" : "issue",
		repo: i.repo,
		repoPath: join(projectFolder, i.repo),
		title: i.title ?? "",
		body: "",
		rules: list(i.rules),
		shortName: i.shortName ?? "",
		...(typeof i.number === "number" ? { number: i.number, linked: true, inProject: true } : {}),
		...(i.url ? { url: i.url } : {}),
		// Continued on GitHub already, by the engineer who recompiled (CMP-80).
		...(typeof i.continues === "number" ? { continued: { title: i.title ?? "", body: "", updated: true, commented: true, touched: true } } : {}),
	}));
	const report: CompileReport = {
		id: file,
		status,
		startedAt: shared.startedAt || startedFromName(file),
		...(shared.finishedAt ? { finishedAt: shared.finishedAt } : {}),
		fromCommit: shared.from,
		toCommit: shared.to,
		...(shared.recompileOf ? { recompileOf: shared.recompileOf } : {}),
		revisions: list(shared.revisions),
		summary: shared.summary ?? "",
		code: list(shared.code),
		changes: [],
		questions: list(shared.questions).map((q) => ({ question: q.question, notes: list(q.notes), anchors: list(q.anchors) })),
		problems: list(shared.problems).map((p) => ({ text: p.problem, anchors: list(p.anchors) })),
		log: [],
		author: shared.compiledBy?.name ?? "",
		authorEmail: shared.compiledBy?.email ?? "",
		...(shared.agent === "acp" ? { agent: "acp" as const } : {}),
		model: shared.model ?? "",
		effort: shared.effort ?? "",
		markerMoved: shared.markerMoved,
		...(readUsage(shared.tokens) ? { tokens: readUsage(shared.tokens) } : {}),
		...(shared.issueFailure ? { issueFailure: shared.issueFailure } : {}),
		issues,
		shared: { file, shortId: shared.id || file.replace(/^.*-([^-/]+)\.json$/, "$1") },
		fromShared: true,
	};
	absorbShared(report, shared, projectFolder);
	return report;
}

/** What turning Share compile reports off asks first (CFG-44). */
export const SHARE_OFF_QUESTION = "Teammates won't see your compiles, and may compile the same revisions again. Turn off?";

/** The question to ask before the Share compile reports toggle changes to `value`: only turning it off asks (CFG-44). */
export function shareToggleQuestion(value: boolean): string | null {
	return value ? null : SHARE_OFF_QUESTION;
}

/** The commit message of the marker carried over from the tag (CFG-45). */
export const IMPORT_MESSAGE = "Share the compile marker";

/** The summary of the marker-only report the tag is carried over in (CFG-45). */
export function importSummary(author: string): string {
	return `Marker carried over from ${author}'s machine`;
}

export interface ImportContext {
	vaultPath: string;
	/** Pushes the vault's `main` as every commit does (CMT-30, CMT-31). */
	push: () => Promise<PushResult>;
	/** The time the report is written at. Unset means now. */
	now?: Date;
}

/**
 * How the marker import ended (CFG-45). `skipped`: nothing to carry over, because there is no tag or `.compiles/`
 * has a report that moved the marker already; nothing is written. `not-shared`: why it wasn't committed or pushed
 * (REP-48). A commit that wasn't made leaves nothing behind, so the import runs again on the next load.
 */
export type ImportResult =
	| { kind: "imported"; file: string; hash: string }
	| { kind: "skipped"; reason: "no-tag" | "marker-shared" }
	| { kind: "not-shared"; reason: string; committed: boolean };

/** The marker-only shared report that carries the tag over (CFG-45): `from` and `to` are the tag, status "Imported". */
export function importedReport(tag: string, compiledBy: Person, at: Date, shortId = newShortId()): SharedReport {
	const time = at.toISOString();
	return {
		version: SHARED_REPORT_VERSION,
		id: shortId,
		compiledBy,
		startedAt: time,
		finishedAt: time,
		// No agent ran: the marker was only carried over.
		agent: "none",
		model: null,
		effort: null,
		from: tag,
		to: tag,
		markerMoved: true,
		status: "imported",
		summary: importSummary(compiledBy.name),
		problems: [],
		questions: [],
		revisions: [],
		code: [],
		issues: [],
		recompileOf: null,
		recompiledBy: null,
		builds: [],
		pullRequests: [],
	};
}

/**
 * The one-time upgrade to shared reports (CFG-45): reads the local tag `theory/compiled`, and when no report in
 * `.compiles/` moved the marker yet, writes one marker-only shared report and commits only it as "Share the compile
 * marker", signed by the engineer, then pushes. The tag is left in place. Reports already in the data file stay
 * there, so they list as "Only on this machine" (REP-51). When two engineers upgrade with different tags, the later
 * `to` wins (REP-49), and whoever pushes second gets the REP-48 notice. Never throws.
 */
export async function importMarker(ctx: ImportContext): Promise<ImportResult> {
	const { vaultPath } = ctx;
	const tag = await tagMarker(vaultPath);
	if (!tag) return { kind: "skipped", reason: "no-tag" };
	// Any report in the folder that moved the marker, committed or not, so an import never runs on top of one.
	const folder = await readSharedFolder(vaultPath).catch(() => [] as SharedFile[]);
	const committed = await committedSharedReports(vaultPath).catch(() => new Map<string, SharedReport>());
	if (folder.some((f) => f.kind === "ok" && f.report.markerMoved) || [...committed.values()].some((r) => r.markerMoved)) {
		return { kind: "skipped", reason: "marker-shared" };
	}
	let file: string;
	let hash: string;
	try {
		const author = await requireIdentity(vaultPath);
		const at = ctx.now ?? new Date();
		const report = importedReport(tag, author, at);
		file = sharedFileName(at.toISOString(), report.id);
		await mkdir(join(vaultPath, COMPILES_FOLDER), { recursive: true });
		await writeFile(join(vaultPath, file), formatSharedReport(report));
		try {
			hash = await commit(vaultPath, IMPORT_MESSAGE, [file]);
		} catch (error) {
			// Nothing is left half done: the file goes, and the next load tries again.
			await rm(join(vaultPath, file), { force: true }).catch(() => {});
			throw error;
		}
	} catch (error) {
		return { kind: "not-shared", reason: errorText(error), committed: false };
	}
	const push = await ctx.push().catch((error): PushResult => ({ kind: "failed", message: errorText(error) }));
	if (push.kind === "rejected") return { kind: "not-shared", reason: `Couldn't push: ${PUSH_REJECTED}`, committed: true };
	if (push.kind === "failed") return { kind: "not-shared", reason: `Couldn't push: ${push.message}`, committed: true };
	return { kind: "imported", file, hash };
}
