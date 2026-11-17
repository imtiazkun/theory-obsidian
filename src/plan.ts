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
}

/** The epic of a plan with several pieces of work. It has no repository of its own: CMP-64 places it. */
export interface PlannedEpic {
	title: string;
	body: string;
	rules: string[];
	shortName: string;
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
			},
			required: ["title", "body", "rules", "shortName"],
		},
		issues: { type: "array", items: ISSUE_SCHEMA, description: "The issue, or the epic's sub-issues in build order: work others depend on comes first." },
	},
	required: ["issues"],
};

/** Null when the short name is fine (CMP-61), else what is wrong with it. */
export function shortNameProblem(name: string): string | null {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return `The short name "${name}" may use only lowercase letters, digits and dashes.`;
	if (name.length > SHORT_NAME_MAX) return `The short name "${name}" is longer than ${SHORT_NAME_MAX} characters.`;
	return null;
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

/**
 * Reads the plan from Claude's answer and checks it: one issue, or an epic with at least two sub-issues (CMP-59),
 * every issue in a repository of the project folder, and every short name and title as CMP-61 and CMP-62 say.
 * The sub-issues keep Claude's order, which is the build order (CMP-60).
 */
export function readPlan(value: unknown, repos: string[]): { plan: Plan | null; problems: string[] } {
	const problems: string[] = [];
	if (!value || typeof value !== "object" || Array.isArray(value)) return { plan: null, problems: ["Claude's answer has no plan."] };
	const raw = value as Record<string, unknown>;
	const issues: PlannedIssue[] = (Array.isArray(raw.issues) ? raw.issues : []).map((i) => {
		const issue = (i ?? {}) as Record<string, unknown>;
		return { repo: text(issue.repo), title: text(issue.title), body: text(issue.body), rules: strings(issue.rules), shortName: text(issue.shortName) };
	});
	let epic: PlannedEpic | null = null;
	if (raw.epic && typeof raw.epic === "object" && !Array.isArray(raw.epic)) {
		const e = raw.epic as Record<string, unknown>;
		epic = { title: text(e.title), body: text(e.body), rules: strings(e.rules), shortName: text(e.shortName) };
	}
	if (epic && issues.length < 2) problems.push("The plan has an epic with fewer than two sub-issues. One piece of work is one issue.");
	if (!epic && issues.length > 1) problems.push("The plan has several issues and no epic. Several pieces of work need an epic.");
	for (const item of [...(epic ? [epic] : []), ...issues]) {
		const title = titleProblem(item.title);
		if (title) problems.push(title);
		const name = shortNameProblem(item.shortName);
		if (name) problems.push(name);
	}
	for (const issue of issues) {
		if (!repos.includes(issue.repo)) problems.push(`The issue "${issue.title}" names a repository that isn't in the project folder: "${issue.repo}".`);
	}
	return problems.length > 0 ? { plan: null, problems } : { plan: { epic, issues }, problems };
}

/** The repository the epic goes in: the one with the most sub-issues, the first by name on a tie (CMP-64). */
export function epicRepo(issues: { repo: string }[]): string {
	const counts = new Map<string, number>();
	for (const issue of issues) counts.set(issue.repo, (counts.get(issue.repo) ?? 0) + 1);
	return [...counts].sort(([a, m], [b, n]) => n - m || (a < b ? -1 : a > b ? 1 : 0))[0][0];
}

/** The report's list of issues to create, the epic first, none of them created yet. */
export function issueRecords(plan: Plan, repoPaths: Map<string, string>): IssueRecord[] {
	const record = (kind: IssueRecord["kind"], repo: string, item: PlannedEpic | PlannedIssue): IssueRecord => ({
		kind,
		repo,
		repoPath: repoPaths.get(repo) ?? "",
		title: item.title,
		body: item.body,
		rules: item.rules,
		shortName: item.shortName,
	});
	const subs = plan.issues.map((issue) => record("issue", issue.repo, issue));
	return plan.epic ? [record("epic", epicRepo(plan.issues), plan.epic), ...subs] : subs;
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

/** Discard: closes every issue already created as not planned (CMP-68). Returns the reasons of the ones it couldn't close. */
export async function discardIssues(github: GitHub, records: IssueRecord[]): Promise<string[]> {
	const failed: string[] = [];
	for (const record of records) {
		if (record.number === undefined || record.discarded) continue;
		try {
			await github.closeIssue(record.repoPath, record.number, "not planned");
			record.discarded = true;
		} catch (error) {
			failed.push(`Couldn't close ${record.repo}#${record.number}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return failed;
}

/** "{n} issues are ready to build." (CMP-16), counting the issues a build builds: never the epic. */
export function readyText(records: IssueRecord[]): string {
	const n = records.filter((r) => r.kind === "issue").length;
	return n === 1 ? "1 issue is ready to build." : `${n} issues are ready to build.`;
}
