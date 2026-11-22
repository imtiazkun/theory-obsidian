import { epicBranchName, issueBranchName } from "./branches";
import type { CompileReport } from "./compile";
import { IssueRecord, canDiscard } from "./plan";
import { IdentityError, git } from "./vault";

/** What a compile's or a recompile's start messages begin with (CMP-75): "Compile failed" or "Recompile failed". */
export function failedPrefix(recompile: boolean): string {
	return recompile ? "Recompile failed" : "Compile failed";
}

/**
 * The notice when a compile or a recompile can't start: "{prefix}: {reason}" (CMP-6 to CMP-8, CMP-36, CMP-55 to
 * CMP-57, CMP-75), except for a git identity problem, which is shown as it is (CMT-11).
 */
export function startFailure(recompile: boolean, error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error);
	return error instanceof IdentityError ? reason : `${failedPrefix(recompile)}: ${reason}`;
}

/** The tooltip of a disabled Recompile when no revision is pending (CMP-74). */
export const COMMIT_ANSWERS_FIRST = "Commit your answers to the model first.";

/** True when the compile succeeded and created at least one issue (CMP-72). */
export function createdIssues(report: CompileReport): boolean {
	return report.status === "succeeded" && (report.issues ?? []).some((i) => i.number !== undefined && !i.discarded);
}

/**
 * The recompile that took this compile's issues over, or null while it has none: a recompile of it that succeeded,
 * or that changed one of its issues on GitHub (CMP-81). A recompile that failed, was cancelled or was discarded
 * before that doesn't count (CMP-82). Read from the reports alone: the link is the recompile's `recompileOf`.
 */
export function recompiledBy(report: CompileReport, reports: CompileReport[]): CompileReport | null {
	return (
		reports.find((r) => r.recompileOf === report.id && (r.status === "succeeded" || !canDiscard(r.issues ?? [], r.closing ?? []))) ?? null
	);
}

/** The compile a recompile's report recompiles, or null when it isn't a recompile or that report is gone (REP-42). */
export function recompiledReport(report: CompileReport, reports: CompileReport[]): CompileReport | null {
	return report.recompileOf === undefined ? null : (reports.find((r) => r.id === report.recompileOf) ?? null);
}

/**
 * Where an issue of a recompiled compile went (REP-41): "continued" when the recompile's plan continues it,
 * "closed" once the recompile closed it, and null when the recompile left it alone or hasn't got to it yet.
 */
export function issueFate(issue: IssueRecord, recompile: CompileReport): "continued" | "closed" | null {
	if (issue.number === undefined) return null;
	const same = (r: { repoPath: string; number?: number }) => r.number === issue.number && r.repoPath === issue.repoPath;
	if ((recompile.issues ?? []).some((r) => r.continued && same(r))) return "continued";
	if ((recompile.closing ?? []).some((c) => c.closed && same(c))) return "closed";
	return null;
}

/** How a recompile's report marks one of its issues (REP-42): continued from the earlier compile, or new. */
export function issueOrigin(issue: IssueRecord): "new" | "continued" {
	return issue.continued ? "continued" : "new";
}

/**
 * The build branch of this name the repository has, here or on `origin` as git last fetched it: the name itself,
 * or `name-2`, `name-3` and so on, which a build uses when the name is taken (BLD-12). Null when there is none.
 */
export async function buildBranch(repoPath: string, name: string): Promise<string | null> {
	const { stdout } = await git(repoPath, ["for-each-ref", "--format=%(refname)", "refs/heads/theory/", "refs/remotes/origin/theory/"]);
	for (const ref of stdout.split("\n")) {
		const branch = ref.trim().replace(/^refs\/(heads|remotes\/origin)\//, "");
		if (branch === name || (branch.startsWith(`${name}-`) && /^[1-9]\d*$/.test(branch.slice(name.length + 1)))) return branch;
	}
	return null;
}

/**
 * Why a compile can't be recompiled (CMP-73), or null when it can. Worked out from the reports alone, so the report
 * view can draw Recompile without waiting. `reports` is every saved report, this one included or not.
 */
export function recompileBlocker(report: CompileReport, reports: CompileReport[]): string | null {
	if (!createdIssues(report)) return "This compile created no issues.";
	if (recompiledBy(report, reports)) return "This compile has been recompiled already.";
	// A later compile's work would be planned twice.
	const later = reports.find((r) => r.id !== report.id && r.status === "succeeded" && r.startedAt > report.startedAt);
	if (later) return `A later compile succeeded (${new Date(later.startedAt).toLocaleString()}).`;
	// Built code would be left with no issue.
	const branch = (report.issues ?? []).find((i) => i.branch);
	if (branch) return `${branch.repo}#${branch.number} has been built on ${branch.branch}.`;
	const epicBranch = report.build?.epicBranches?.[0];
	if (epicBranch) return `A build made the epic branch ${epicBranch.branch}.`;
	const pr = report.pullRequests?.[0];
	if (pr) return `A pull request was opened for this compile: ${pr.url}`;
	return null;
}

/**
 * CMP-73 checked at the start of a recompile (CMP-75): `recompileBlocker`, then every build branch the compile's
 * issues could have, here or on `origin`, as git last fetched it, `-2` names included (BLD-12).
 */
export async function recompileProblem(report: CompileReport, reports: CompileReport[]): Promise<string | null> {
	const blocker = recompileBlocker(report, reports);
	if (blocker) return blocker;
	const issues = (report.issues ?? []).filter((i) => i.number !== undefined && !i.discarded);
	const epic = issues.find((i) => i.kind === "epic");
	for (const issue of issues) {
		if (issue.kind !== "issue") continue;
		const names = [issueBranchName(issue), ...(epic ? [epicBranchName(epic)] : [])];
		for (const name of names) {
			const found = await buildBranch(issue.repoPath, name);
			if (found) return `The build branch ${found} exists in ${issue.repo}.`;
		}
	}
	return null;
}

/** How the report draws Recompile (CMP-72 to CMP-74). `pending` is the number of pending revisions, or null while unknown. */
export type RecompileButton = { shown: false } | { shown: true; disabled: boolean; tooltip?: string };

export function recompileButton(report: CompileReport, reports: CompileReport[], pending: number | null, busy: boolean): RecompileButton {
	if (recompileBlocker(report, reports)) return { shown: false };
	if (!pending) return { shown: true, disabled: true, ...(pending === 0 ? { tooltip: COMMIT_ANSWERS_FIRST } : {}) };
	return { shown: true, disabled: busy };
}
