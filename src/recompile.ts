import { epicBranchName, issueBranchName, refExists } from "./branches";
import type { CompileReport } from "./compile";
import { canDiscard } from "./plan";
import { IdentityError } from "./vault";

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
 * Why a compile can't be recompiled (CMP-73), or null when it can. Worked out from the reports alone, so the report
 * view can draw Recompile without waiting. `reports` is every saved report, this one included or not.
 */
export function recompileBlocker(report: CompileReport, reports: CompileReport[]): string | null {
	if (!createdIssues(report)) return "This compile created no issues.";
	// Recompiled already: a recompile of it succeeded, or changed one of its issues on GitHub (CMP-81, CMP-82).
	const recompiled = reports.some(
		(r) => r.recompileOf === report.id && (r.status === "succeeded" || !canDiscard(r.issues ?? [], r.closing ?? [])),
	);
	if (recompiled) return "This compile has been recompiled already.";
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
 * issues could have, here or on `origin`, as git last fetched it.
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
			if ((await refExists(issue.repoPath, `refs/heads/${name}`)) || (await refExists(issue.repoPath, `refs/remotes/origin/${name}`))) {
				return `The build branch ${name} exists in ${issue.repo}.`;
			}
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
