import type { GitHub } from "./github";
import type { Revision } from "./compile";

/** One piece of planned work: it changes exactly one repository (CMP-12). */
export interface PlannedIssue {
	/** The repository's name in the project folder. */
	repo: string;
	title: string;
	body: string;
	/** The rule IDs it covers. They are its acceptance criteria. */
	rules: string[];
	/** Says what changes, like `commit-page-diffs`. Branches are named from it (CMP-61). */
	shortName: string;
	/** In a recompile: the number of the earlier issue this one continues (CMP-77). */
	continues?: number;
	/** In a recompile: one sentence on what changed in the issue it continues, and why (CMP-79). */
	changed?: string;
}

/** The epic of a plan with several pieces of work. It has no repository of its own: CMP-64 places it. */
export interface PlannedEpic {
	title: string;
	body: string;
	rules: string[];
	shortName: string;
	/** In a recompile: the number of the earlier epic this one continues (CMP-77). */
	continues?: number;
	/** In a recompile: one sentence on what changed in the epic it continues, and why (CMP-79). */
	changed?: string;
}

/** A compile's plan: one issue, or an epic with its sub-issues in build order (CMP-15, CMP-59, CMP-60). */
export interface Plan {
	epic: PlannedEpic | null;
	issues: PlannedIssue[];
}

/** Where an issue stands in a build (BLD-3). */
export type BuildState = "waiting" | "building" | "built" | "skipped" | "failed";

/** One issue a compile creates, as far as it got. The epic comes first in a report's list. */
export interface IssueRecord {
	kind: "epic" | "issue";
	/** The repository's name in the project folder. */
	repo: string;
	/** Absolute path of the code repository. */
	repoPath: string;
	title: string;
	/** Claude's body, before the plugin adds the rules and the revisions. */
	body: string;
	rules: string[];
	shortName: string;
	/** Set once the issue exists on GitHub. */
	number?: number;
	url?: string;
	/** For a sub-issue: linked to the epic as a native sub-issue (CMP-64). */
	linked?: boolean;
	/** Added to the GitHub Project (CMP-66). */
	inProject?: boolean;
	/** Closed as not planned by Discard (CMP-68). */
	discarded?: boolean;
	/** Unset until a build looks at it. Never set on the epic. */
	build?: BuildState;
	/** The issue branch a build made for it. */
	branch?: string;
	/** Claude's summary from the build. */
	summary?: string;
	/** In a recompile: the CMP-79 sentence on what changed in the earlier issue this record continues. */
	changed?: string;
	/** In a recompile: set when this record continues the earlier issue with the same number (CMP-77). */
	continued?: ContinuedIssue;
}

/** What a recompile must still do to an earlier issue it continues (CMP-80), and what it has done. */
export interface ContinuedIssue {
	/** The earlier issue's title and Claude's body, to tell whether they changed (CMP-80 step 2). */
	title: string;
	body: string;
	/** Step 2: the title and body on GitHub are the new plan's. */
	updated?: boolean;
	/** Step 2: the CMP-79 comment is posted, or isn't needed. */
	commented?: boolean;
	/** Step 3: the epic it is still a sub-issue of on GitHub, which isn't the new plan's. Cleared once it left. */
	unlinkFrom?: { repo: string; repoPath: string; number: number };
	/** Set once anything about the issue changed on GitHub: Discard is then gone (CMP-81). */
	touched?: boolean;
}

/** An earlier issue a recompile's plan doesn't continue, closed in step 4 (CMP-80). */
export interface ClosingIssue {
	kind: "epic" | "issue";
	repo: string;
	repoPath: string;
	number: number;
	url?: string;
	title: string;
	/** The step 4 comment is posted. */
	commented?: boolean;
	/** Closed as not planned. */
	closed?: boolean;
}

export const SHORT_NAME_MAX = 40;
export const TITLE_MAX = 70;

const ISSUE_SCHEMA = {
	type: "object",
	properties: {
		repo: { type: "string", description: "The repository's name in the project folder. The issue changes only this repository." },
		title: { type: "string", description: "A short sentence in the imperative, under 70 characters." },
		body: { type: "string", description: "What to build and why, in the model's words." },
		rules: { type: "array", items: { type: "string" }, description: "The rule IDs the issue covers, like CMP-12. They are its acceptance criteria." },
		shortName: { type: "string", description: "Says what changes, like commit-page-diffs: lowercase letters, digits and dashes, at most 40 characters." },
		continues: {
			type: "integer",
			description: "Only in a recompile: the number of the earlier open issue this one continues. Leave it out for new work.",
		},
		changed: {
			type: "string",
			description: "Only with continues: one sentence on what changed and why, like \"Now names the description of each check, answered in STAT-10.\"",
		},
	},
	required: ["repo", "title", "body", "rules", "shortName"],
};

/** The plan's shape in the answer (CMP-15). */
export const PLAN_SCHEMA = {
	type: "object",
	description: "One issue (no epic, one entry in issues), or an epic with its sub-issues in build order.",
	properties: {
		epic: {
			type: "object",
			description: "Only when the work spans several repositories or several intents. Leave it out for one issue.",
			properties: {
				title: ISSUE_SCHEMA.properties.title,
				body: ISSUE_SCHEMA.properties.body,
				rules: ISSUE_SCHEMA.properties.rules,
				shortName: ISSUE_SCHEMA.properties.shortName,
				continues: { ...ISSUE_SCHEMA.properties.continues, description: "Only in a recompile: the number of the earlier open epic this one continues. Leave it out for a new epic." },
				changed: ISSUE_SCHEMA.properties.changed,
			},
			required: ["title", "body", "rules", "shortName"],
		},
		issues: { type: "array", items: ISSUE_SCHEMA, description: "The issue, or the epic's sub-issues in build order: work others depend on comes first." },
	},
	required: ["issues"],
};

/** Null when the short name is fine (CMP-61), else what is wrong with it, to follow "which". */
function shortNameReason(name: string): string | null {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return "may use only lowercase letters, digits and dashes";
	if (name.length > SHORT_NAME_MAX) return `is longer than ${SHORT_NAME_MAX} characters`;
	return null;
}

/** Null when the short name is fine (CMP-61), else what is wrong with it. */
export function shortNameProblem(name: string): string | null {
	const reason = shortNameReason(name);
	return reason ? `The short name "${name}" ${reason}.` : null;
}

/** Null when the title is fine (CMP-62), else what is wrong with it. Whether it is imperative is Claude's to get right. */
export function titleProblem(title: string): string | null {
	if (!title.trim()) return "An issue has no title.";
	if (title.trim().length >= TITLE_MAX) return `The title "${title.trim()}" isn't under ${TITLE_MAX} characters.`;
	return null;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean) : [];
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** How a plan's problem names the issue it is about: by its title, else by its short name (CMP-70). */
function named(kind: "epic" | "issue", item: { title: string; shortName: string }): string {
	if (item.title) return `The ${kind} "${item.title}"`;
	if (item.shortName) return `The ${kind} with the short name "${item.shortName}"`;
	return `An ${kind === "epic" ? "epic" : "issue"} with no title and no short name`;
}

/** The optional CMP-77 fields of a planned issue or epic: kept only when Claude set them. `bad` when `continues` isn't an issue number. */
function continuation(raw: Record<string, unknown>): { continues?: number; changed?: string; bad?: true } {
	const result: { continues?: number; changed?: string; bad?: true } = {};
	if (raw.continues !== undefined && raw.continues !== null) {
		if (typeof raw.continues === "number" && Number.isInteger(raw.continues) && raw.continues > 0) result.continues = raw.continues;
		else result.bad = true;
	}
	const changed = text(raw.changed);
	if (changed) result.changed = changed;
	return result;
}

/** How a problem names an earlier issue: `repo#number`. */
function earlierName(record: IssueRecord): string {
	return `${record.repo}#${record.number}`;
}

/**
 * The CMP-78 limits on continuing earlier issues, as problems. `earlier` is the earlier compile's issues that are
 * still open, or null when the compile isn't a recompile, where nothing may be continued. Each problem names the
 * issue it is about. An epic's repository isn't checked: CMP-64 keeps a continued epic where it is.
 */
function continuationProblems(
	items: [kind: "epic" | "issue", item: PlannedEpic | PlannedIssue][],
	earlier: IssueRecord[] | null,
): string[] {
	const problems: string[] = [];
	const used = new Map<IssueRecord, string[]>();
	for (const [kind, item] of items) {
		if (item.continues === undefined) continue;
		const who = named(kind, item);
		const n = item.continues;
		if (!earlier) {
			problems.push(`${who} continues #${n}, but this compile isn't a recompile, so it can't continue an earlier issue.`);
			continue;
		}
		const candidates = earlier.filter((r) => r.number === n);
		if (candidates.length === 0) {
			problems.push(`${who} continues #${n}, which isn't an open issue of the earlier compile.`);
			continue;
		}
		let match: IssueRecord | undefined;
		if (kind === "epic") {
			match = candidates.find((r) => r.kind === "epic");
			if (!match) {
				problems.push(`${who} continues ${earlierName(candidates[0])}, which is an issue. An epic can only continue an epic.`);
				continue;
			}
		} else {
			const repo = (item as PlannedIssue).repo;
			match = candidates.find((r) => r.kind === "issue" && r.repo === repo);
			if (!match) {
				const sameRepo = candidates.find((r) => r.repo === repo);
				const otherIssue = candidates.find((r) => r.kind === "issue");
				if (sameRepo || !otherIssue) {
					problems.push(`${who} continues ${earlierName(sameRepo ?? candidates[0])}, which is an epic. An issue can only continue an issue.`);
				} else {
					problems.push(`${who} continues ${earlierName(otherIssue)}, which is in another repository. An issue must stay in its repository: "${repo}" isn't "${otherIssue.repo}".`);
				}
				continue;
			}
		}
		used.set(match, [...(used.get(match) ?? []), who]);
	}
	for (const [record, users] of used) {
		if (users.length > 1) problems.push(`${earlierName(record)} is continued more than once: ${users.join(", ")}.`);
	}
	return problems;
}

/**
 * Reads the plan from Claude's answer and checks it (CMP-70): one issue, or an epic with at least two sub-issues
 * (CMP-59), every issue in a repository of the project folder, every issue (the epic included) with at least one
 * rule ID, every short name and title as CMP-61 and CMP-62 say, and no short name used twice. In a recompile,
 * `earlier` is the earlier compile's issues that are still open, and the CMP-78 limits on continuing them are
 * checked too; without it, a plan that continues anything is refused. Each problem names the issue it is about.
 * The sub-issues keep Claude's order, which is the build order (CMP-60). A plan with no epic and no issues is
 * empty: the code already matches the model (CMP-71).
 */
export function readPlan(value: unknown, repos: string[], earlier: IssueRecord[] | null = null): { plan: Plan | null; problems: string[] } {
	const problems: string[] = [];
	if (!value || typeof value !== "object" || Array.isArray(value)) return { plan: null, problems: ["Claude's answer has no plan."] };
	const raw = value as Record<string, unknown>;
	const badNumbers: [kind: "epic" | "issue", item: PlannedEpic | PlannedIssue][] = [];
	const issues: PlannedIssue[] = (Array.isArray(raw.issues) ? raw.issues : []).map((i) => {
		const issue = (i ?? {}) as Record<string, unknown>;
		const { bad, ...more } = continuation(issue);
		const planned: PlannedIssue = { repo: text(issue.repo), title: text(issue.title), body: text(issue.body), rules: strings(issue.rules), shortName: text(issue.shortName), ...more };
		if (bad) badNumbers.push(["issue", planned]);
		return planned;
	});
	let epic: PlannedEpic | null = null;
	if (raw.epic && typeof raw.epic === "object" && !Array.isArray(raw.epic)) {
		const e = raw.epic as Record<string, unknown>;
		const { bad, ...more } = continuation(e);
		epic = { title: text(e.title), body: text(e.body), rules: strings(e.rules), shortName: text(e.shortName), ...more };
		if (bad) badNumbers.unshift(["epic", epic]);
	}
	if (epic && issues.length < 2) problems.push(`${named("epic", epic)} has fewer than two sub-issues. One piece of work is one issue.`);
	if (!epic && issues.length > 1) problems.push("The plan has several issues and no epic. Several pieces of work need an epic.");
	const items: [kind: "epic" | "issue", item: PlannedEpic | PlannedIssue][] = [
		...(epic ? [["epic", epic] as ["epic", PlannedEpic]] : []),
		...issues.map((i) => ["issue", i] as ["issue", PlannedIssue]),
	];
	for (const [kind, item] of items) {
		const who = named(kind, item);
		if (!item.title) problems.push(`${who} has no title.`);
		else if (item.title.length >= TITLE_MAX) problems.push(`${who} has a title that isn't under ${TITLE_MAX} characters.`);
		const name = shortNameReason(item.shortName);
		if (name) problems.push(`${who} has ${item.shortName ? `the short name "${item.shortName}", which ${name}` : "no short name"}.`);
		if (item.rules.length === 0) problems.push(`${who} lists no rule IDs.`);
		if (kind === "issue" && !repos.includes((item as PlannedIssue).repo)) {
			problems.push(`${who} names a repository that isn't in the project folder: "${(item as PlannedIssue).repo}".`);
		}
	}
	const byName = new Map<string, string[]>();
	for (const [kind, item] of items) {
		if (!item.shortName) continue;
		byName.set(item.shortName, [...(byName.get(item.shortName) ?? []), named(kind, item)]);
	}
	for (const [name, users] of byName) {
		if (users.length > 1) problems.push(`The short name "${name}" is used more than once in the plan: ${users.join(", ")}.`);
	}
	for (const [kind, item] of badNumbers) problems.push(`${named(kind, item)} continues something that isn't an issue number.`);
	problems.push(...continuationProblems(items, earlier));
	return problems.length > 0 ? { plan: null, problems } : { plan: { epic, issues }, problems };
}

/** True when the plan has nothing to build: no epic and no issues (CMP-71). */
export function isEmptyPlan(plan: Plan): boolean {
	return !plan.epic && plan.issues.length === 0;
}

/**
 * The repository the epic goes in: the one with the most sub-issues, the first by name on a tie (CMP-64). A
 * continued epic stays in the repository of the earlier epic it continues, whatever its sub-issues say.
 */
export function epicRepo(issues: { repo: string }[], continued?: { repo: string } | null): string {
	if (continued) return continued.repo;
	const counts = new Map<string, number>();
	for (const issue of issues) counts.set(issue.repo, (counts.get(issue.repo) ?? 0) + 1);
	return [...counts].sort(([a, m], [b, n]) => n - m || (a < b ? -1 : a > b ? 1 : 0))[0][0];
}

/** The earlier issue a planned item continues, as `readPlan` matched it (CMP-78), or undefined for new work. */
function continuedRecord(kind: "epic" | "issue", item: PlannedEpic | PlannedIssue, earlier: IssueRecord[]): IssueRecord | undefined {
	if (item.continues === undefined) return undefined;
	return earlier.find(
		(r) => r.number === item.continues && !r.discarded && r.kind === kind && (kind === "epic" || r.repo === (item as PlannedIssue).repo),
	);
}

/**
 * The report's list of issues, the epic first. New ones aren't created yet. In a recompile, `earlier` is the
 * earlier compile's issues: an item that continues one gets its number, its address and its place in the
 * project, with what is still to do to it on GitHub (CMP-80). The earlier records are never changed (CMP-82).
 */
export function issueRecords(plan: Plan, repoPaths: Map<string, string>, earlier: IssueRecord[] = []): IssueRecord[] {
	const earlierEpic = earlier.find((r) => r.kind === "epic" && r.number !== undefined && !r.discarded) ?? null;
	const epicFrom = plan.epic ? continuedRecord("epic", plan.epic, earlier) : undefined;
	const record = (kind: IssueRecord["kind"], repo: string, item: PlannedEpic | PlannedIssue, from?: IssueRecord): IssueRecord => {
		const result: IssueRecord = {
			kind,
			repo,
			repoPath: from?.repoPath ?? repoPaths.get(repo) ?? "",
			title: item.title,
			body: item.body,
			rules: item.rules,
			shortName: item.shortName,
		};
		if (!from) return result;
		result.number = from.number;
		if (from.url) result.url = from.url;
		if (from.inProject) result.inProject = true;
		if (item.changed) result.changed = item.changed;
		result.continued = { title: from.title, body: from.body };
		if (kind === "issue") {
			// The epic it is a sub-issue of now, on GitHub (CMP-80 step 3).
			const parent = from.kind === "issue" && from.linked && earlierEpic ? earlierEpic : null;
			const stays = parent !== null && epicFrom === parent;
			if (stays) result.linked = true;
			else if (parent) result.continued.unlinkFrom = { repo: parent.repo, repoPath: parent.repoPath, number: parent.number as number };
		}
		return result;
	};
	const subs = plan.issues.map((issue) => record("issue", issue.repo, issue, continuedRecord("issue", issue, earlier)));
	return plan.epic ? [record("epic", epicRepo(plan.issues, epicFrom), plan.epic, epicFrom), ...subs] : subs;
}

/** The earlier compile's open issues that the new plan doesn't continue: a recompile closes them in step 4 (CMP-80). */
export function closingIssues(open: IssueRecord[], records: IssueRecord[]): ClosingIssue[] {
	const kept = (r: IssueRecord) => records.some((n) => n.continued && n.number === r.number && n.repoPath === r.repoPath);
	return open
		.filter((r) => r.number !== undefined && !r.discarded && !kept(r))
		.map((r) => ({ kind: r.kind, repo: r.repo, repoPath: r.repoPath, number: r.number as number, ...(r.url ? { url: r.url } : {}), title: r.title }));
}

/** The body an issue gets on GitHub: Claude's body, the rules it covers, then the vault revisions it was planned from (CMP-67). */
export function issueBody(record: IssueRecord, revisions: Revision[]): string {
	const parts = [record.body.trim()];
	if (record.rules.length > 0) parts.push(`Rules: ${record.rules.join(", ")}`);
	parts.push(
		["---", "Planned by theory.md from these revisions of the model:", ...revisions.map((r) => `- ${r.hash.slice(0, 7)} ${r.subject}`)].join("\n"),
	);
	return parts.filter(Boolean).join("\n\n");
}

export const EPIC_LABEL = "epic";

/**
 * Creates the issues still missing, in order: the epic first with its label (CMP-65), then each sub-issue linked to
 * it (CMP-64), and every one added to the GitHub Project (CMP-66). Records each step in `records` as it is done, so
 * Retry carries on where it stopped (CMP-68). Throws at the first step GitHub refuses.
 */
export async function createIssues(
	github: GitHub,
	records: IssueRecord[],
	revisions: Revision[],
	projectUrl: string,
	saved: () => void,
): Promise<void> {
	const epic = records.find((r) => r.kind === "epic") ?? null;
	for (const record of records) {
		// A continued issue already exists: steps 2 and 3 of a recompile see to it (CMP-80).
		if (record.continued) continue;
		if (record.number === undefined) {
			const labels = record.kind === "epic" ? [EPIC_LABEL] : [];
			if (record.kind === "epic") await github.ensureLabel(record.repoPath, EPIC_LABEL);
			const created = await github.createIssue(record.repoPath, { title: record.title, body: issueBody(record, revisions), labels });
			record.number = created.number;
			record.url = created.url;
			saved();
		}
		if (epic && record !== epic && !record.linked) {
			await github.addSubIssue(epic.repoPath, epic.number as number, record.repoPath, record.number);
			record.linked = true;
			saved();
		}
		if (!record.inProject) {
			await github.addToProject(projectUrl, record.url as string, record.repoPath);
			record.inProject = true;
			saved();
		}
	}
}

/** The steps of bringing GitHub in line with a plan, in order (CMP-80). A first compile only creates. */
export type SyncStep = "create" | "update" | "link" | "close";

/** A step GitHub refused, with the reason. */
export class SyncError extends Error {
	constructor(readonly step: SyncStep, readonly reason: string) {
		super(reason);
	}
}

/** How the report names a failed step, before the reason (CMP-68, CMP-81). */
export const SYNC_FAILURE: Record<SyncStep, string> = {
	create: "Couldn't create the issues",
	update: "Couldn't update the continued issues",
	link: "Couldn't link the sub-issues",
	close: "Couldn't close the earlier issues",
};

/** How an issue is named in a GitHub comment: its address, else `repo#number`. */
function reference(record: { repo: string; number?: number; url?: string }): string {
	return record.url ?? `${record.repo}#${record.number}`;
}

/** The step 2 comment on a continued issue: the CMP-79 sentence and the revision it was planned from (CMP-80). */
export function updateComment(record: IssueRecord, revision: string): string {
	const changed = record.changed?.trim() || "The plan for this issue changed.";
	return `${changed}\n\nPlanned again by theory.md from revision ${revision.slice(0, 7)} of the model.`;
}

/**
 * The step 4 comment on an earlier issue the new plan doesn't continue (CMP-80): "No longer planned after
 * {revision}. The new plan is {epic or issues}.", or, when the new plan is empty (CMP-71), "The model no longer
 * asks for this work ({revision})."
 */
export function closeComment(records: IssueRecord[], revision: string): string {
	const short = revision.slice(0, 7);
	if (records.length === 0) return `The model no longer asks for this work (${short}).`;
	const epic = records.find((r) => r.kind === "epic");
	const plan = epic ? reference(epic) : records.map(reference).join(", ");
	return `No longer planned after ${short}. The new plan is ${plan}.`;
}

async function step(name: SyncStep, work: () => Promise<void>) {
	try {
		await work();
	} catch (error) {
		throw new SyncError(name, error instanceof Error ? error.message : String(error));
	}
}

/**
 * Brings GitHub in line with a plan, in the order of CMP-80: create the new issues (`createIssues`), update each
 * continued one (title and body, then a comment only when the title or body changed), link the sub-issues to
 * the new plan's epic (leaving an epic that isn't in the plan first), then close each earlier issue in `closing`
 * as not planned, after its comment. Records each step in `records` and `closing` as it is done, so Retry
 * carries on from there (CMP-81). Throws a `SyncError` at the first step GitHub refuses. `revision` is the
 * vault revision the plan was made from.
 */
export async function syncIssues(
	github: GitHub,
	records: IssueRecord[],
	closing: ClosingIssue[],
	revisions: Revision[],
	revision: string,
	projectUrl: string,
	saved: () => void,
): Promise<void> {
	await step("create", () => createIssues(github, records, revisions, projectUrl, saved));
	await step("update", async () => {
		for (const record of records) {
			const continued = record.continued;
			if (!continued) continue;
			if (!continued.updated) {
				await github.editIssue(record.repoPath, record.number as number, { title: record.title, body: issueBody(record, revisions) });
				continued.updated = true;
				continued.touched = true;
				saved();
			}
			if (!continued.commented) {
				if (record.title !== continued.title || record.body !== continued.body) {
					await github.commentIssue(record.repoPath, record.number as number, updateComment(record, revision));
				}
				continued.commented = true;
				saved();
			}
			if (!record.inProject && record.url) {
				await github.addToProject(projectUrl, record.url, record.repoPath);
				record.inProject = true;
				saved();
			}
		}
	});
	await step("link", async () => {
		const epic = records.find((r) => r.kind === "epic") ?? null;
		for (const record of records) {
			const continued = record.continued;
			if (!continued || record.kind !== "issue") continue;
			if (continued.unlinkFrom) {
				const from = continued.unlinkFrom;
				await github.removeSubIssue(from.repoPath, from.number, record.repoPath, record.number as number);
				delete continued.unlinkFrom;
				continued.touched = true;
				saved();
			}
			if (epic && !record.linked) {
				await github.addSubIssue(epic.repoPath, epic.number as number, record.repoPath, record.number as number);
				record.linked = true;
				continued.touched = true;
				saved();
			}
		}
	});
	await step("close", async () => {
		const comment = closeComment(records, revision);
		for (const earlier of closing) {
			if (!earlier.commented) {
				await github.commentIssue(earlier.repoPath, earlier.number, comment);
				earlier.commented = true;
				saved();
			}
			if (!earlier.closed) {
				await github.closeIssue(earlier.repoPath, earlier.number, "not planned");
				earlier.closed = true;
				saved();
			}
		}
	});
}

/** True while no earlier issue has been changed on GitHub, so Discard is still offered (CMP-81). */
export function canDiscard(records: IssueRecord[], closing: ClosingIssue[] = []): boolean {
	return !records.some((r) => r.continued?.touched) && !closing.some((c) => c.commented || c.closed);
}

/** What is still to do on GitHub, in order, for the report while a step failed (CMP-81). */
export function stepsLeft(records: IssueRecord[], closing: ClosingIssue[] = []): string[] {
	const steps: string[] = [];
	const name = (r: { kind: string; repo: string; number?: number; title: string }) =>
		r.number === undefined ? `the ${r.kind} "${r.title}" in ${r.repo}` : `${r.repo}#${r.number}`;
	const epic = records.find((r) => r.kind === "epic") ?? null;
	for (const r of records) {
		if (r.continued) continue;
		if (r.number === undefined) {
			steps.push(`Create ${name(r)}.`);
			continue;
		}
		if (epic && r !== epic && !r.linked) steps.push(`Link ${name(r)} to ${name(epic)}.`);
		if (!r.inProject) steps.push(`Add ${name(r)} to the GitHub Project.`);
	}
	for (const r of records) {
		if (r.continued && (!r.continued.updated || !r.continued.commented)) steps.push(`Update ${name(r)}.`);
	}
	for (const r of records) {
		if (!r.continued || r.kind !== "issue") continue;
		if (r.continued.unlinkFrom) steps.push(`Remove ${name(r)} from ${r.continued.unlinkFrom.repo}#${r.continued.unlinkFrom.number}.`);
		if (epic && !r.linked) steps.push(`Link ${name(r)} to ${name(epic)}.`);
	}
	for (const c of closing) if (!c.closed) steps.push(`Close ${name(c)} as not planned.`);
	return steps;
}

/** Discard: closes every issue already created as not planned (CMP-68). Returns the reasons of the ones it couldn't close. */
export async function discardIssues(github: GitHub, records: IssueRecord[]): Promise<string[]> {
	const failed: string[] = [];
	for (const record of records) {
		// An earlier issue a recompile continues was never this compile's to close (CMP-81).
		if (record.number === undefined || record.discarded || record.continued) continue;
		try {
			await github.closeIssue(record.repoPath, record.number, "not planned");
			record.discarded = true;
		} catch (error) {
			failed.push(`Couldn't close ${record.repo}#${record.number}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return failed;
}

/**
 * The end notice of a compile that succeeded: "{n} issues are ready to build." (CMP-16), or "The code already
 * matches the model." when it had nothing to build (CMP-71), then the CMP-21 question count.
 */
export function compileFinishedText(records: IssueRecord[], questions: number): string {
	const done = records.length === 0 ? "The code already matches the model." : readyText(records);
	return `Compile finished. ${done}${questionText(questions)}`;
}

/** " Claude has N questions about the model." (CMP-21), or nothing without questions. */
export function questionText(questions: number): string {
	return questions > 0 ? ` Claude has ${questions} question${questions === 1 ? "" : "s"} about the model.` : "";
}

/** "{n} issues are ready to build." (CMP-16), counting the issues a build builds: never the epic. */
export function readyText(records: IssueRecord[]): string {
	const n = records.filter((r) => r.kind === "issue").length;
	return n === 1 ? "1 issue is ready to build." : `${n} issues are ready to build.`;
}
