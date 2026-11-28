import type { CompileReport, CompileStatus } from "./compile";
import { type SharedFile, type SharedReport, absorbShared, fromSharedReport, startedFromName } from "./shared-report";

export const STATUS_TEXT: Record<CompileStatus, string> = {
	running: "Compiling…",
	succeeded: "Compiled",
	failed: "Failed",
	cancelled: "Cancelled",
	// The marker-only report that carried the old tag over (CFG-45).
	imported: "Imported",
};

/** How a report kept only in the data file is marked (REP-51). */
export const ONLY_HERE = "Only on this machine";

/** One line of the report dropdown and the compile history (REP-51, REP-52). */
export type ReportEntry =
	/** `onlyHere`: the report is only in the data file, never shared or not shared yet (REP-48). */
	| { kind: "report"; report: CompileReport; onlyHere: boolean }
	/** A file in `.compiles/` the plugin can't read. It is never overwritten and never counts for the marker. */
	| { kind: "broken"; file: string; startedAt: string };

/** The id a broken file's entry has in the dropdown. Never a report's id. */
export function brokenId(file: string): string {
	return `broken:${file}`;
}

export function entryId(entry: ReportEntry): string {
	return entry.kind === "report" ? entry.report.id : brokenId(entry.file);
}

// The file each report read from `.compiles/` was made from, so a list drawn again reuses it.
const sources = new WeakMap<CompileReport, SharedReport>();

function time(value: string): number {
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? -Infinity : ms;
}

/**
 * The reports in the data file and the shared reports in `.compiles/` together, newest first (REP-51). A shared
 * report this machine has in its data file is listed once, as that report; every other one is read from its file,
 * by its file. A file that can't be read is listed as broken (REP-52). `files` is null until `.compiles/` was read.
 * `previous` is the list drawn before, so a shared report keeps the pull request states asked of GitHub (REP-34).
 */
export function listReports(
	local: CompileReport[],
	files: SharedFile[] | null,
	projectFolder: string,
	previous: ReportEntry[] = [],
): ReportEntry[] {
	const byFile = new Map<string, CompileReport>();
	for (const report of local) if (report.shared) byFile.set(report.shared.file, report);
	const readable = new Set((files ?? []).filter((f) => f.kind === "ok").map((f) => f.file));
	const entries: ReportEntry[] = local.map((report) => ({
		kind: "report",
		report,
		onlyHere: !report.shared || report.notShared !== undefined || (files !== null && !readable.has(report.shared.file)),
	}));
	const before = new Map<string, CompileReport>();
	for (const entry of previous) if (entry.kind === "report" && entry.report.fromShared) before.set(entry.report.id, entry.report);
	const ids = new Set(local.map((r) => r.id));
	for (const file of files ?? []) {
		if (file.kind === "broken") {
			entries.push({ kind: "broken", file: file.file, startedAt: startedFromName(file.file) });
			continue;
		}
		if (byFile.has(file.file) || ids.has(file.file)) continue;
		// The same file as last read gives the same report, so what was asked of GitHub meanwhile stays with it.
		const seen = before.get(file.file);
		const report = seen && sources.get(seen) === file.report ? seen : fromSharedReport(file.report, file.file, projectFolder);
		sources.set(report, file.report);
		// A recompile links the earlier report by its file. On this machine that report may have an id of its own.
		if (file.report.recompileOf) report.recompileOf = byFile.get(file.report.recompileOf)?.id ?? file.report.recompileOf;
		if (report !== seen) {
			for (const pr of report.pullRequests ?? []) {
				const state = seen?.pullRequests?.find((p) => p.url === pr.url)?.state;
				if (state) pr.state = state;
			}
		}
		entries.push({ kind: "report", report, onlyHere: false });
	}
	const startedAt = (entry: ReportEntry) => (entry.kind === "report" ? entry.report.startedAt : entry.startedAt);
	// Newest first. Array.sort is stable, so reports started at the same time keep their order.
	return entries.sort((a, b) => time(startedAt(b)) - time(startedAt(a)));
}

/**
 * Takes in what teammates added to the shared reports this machine has in its data file (REP-50): their builds and
 * pull requests. The report of the compile or build running now is left alone. Returns true when any file was read.
 */
export function absorbSharedFiles(local: CompileReport[], files: SharedFile[], projectFolder: string, activeId: string | null): boolean {
	let absorbed = false;
	for (const report of local) {
		if (!report.shared || report.id === activeId || report.status === "running") continue;
		const file = files.find((f) => f.file === report.shared?.file);
		if (file?.kind !== "ok") continue;
		absorbShared(report, file.report, projectFolder);
		absorbed = true;
	}
	return absorbed;
}

/**
 * A report's line in the report dropdown (REP-3, REP-51, REP-52): when it started and its status, then who compiled
 * a shared report, or "Only on this machine". A broken file is "Can't read {file}".
 */
export function entryLabel(entry: ReportEntry): string {
	if (entry.kind === "broken") return `Can't read ${entry.file}`;
	const { report } = entry;
	const parts = [new Date(report.startedAt).toLocaleString(), STATUS_TEXT[report.status]];
	if (entry.onlyHere) parts.push(ONLY_HERE);
	else if (report.author) parts.push(report.author);
	return parts.join(" · ");
}

/** The reports of a list, without the broken files. */
export function listedReports(entries: ReportEntry[]): CompileReport[] {
	return entries.flatMap((entry) => (entry.kind === "report" ? [entry.report] : []));
}
