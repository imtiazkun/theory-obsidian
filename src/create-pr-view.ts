import { ItemView, Notice, Setting, ViewStateResult, WorkspaceLeaf, setIcon } from "obsidian";
import {
	BranchCommit,
	CompileBranch,
	branchCommits,
	isOpenCompileBranch,
	projectRepos,
	recordedPullRequest,
} from "./branches";
import type { CompileReport } from "./compile";
import {
	PullRequest,
	createPullRequest,
	editPullRequestBody,
	ghProblem,
	githubOrigin,
	pullRequestBody,
	remoteBranches,
} from "./github";
import type TheoryPlugin from "./main";
import { generatePullRequestBody, type PullRequestBodyRun } from "./pr-body";

export const CREATE_PR_VIEW_TYPE = "theory-create-pr";

/** Marks where the footer starts, so a second Create replaces it instead of adding another. */
const FOOTER_MARK = "<!-- theory.md compile -->";

/** A repository whose compile branch has commits and no pull request yet. */
export interface PullRequestCandidate {
	branch: CompileBranch;
	/** Commits on the compile branch that aren't in its base. */
	commits: BranchCommit[];
}

/** The repositories of this report that still need a pull request: an open compile branch, with commits, and none yet. */
export async function pullRequestCandidates(report: CompileReport, reports: CompileReport[]): Promise<PullRequestCandidate[]> {
	const candidates: PullRequestCandidate[] = [];
	for (const branch of report.branches ?? []) {
		if (!branch.kept || (await recordedPullRequest(reports, branch.repoPath, branch.branch))) continue;
		if (!(await isOpenCompileBranch(branch.repoPath, branch.branch, branch.base, reports))) continue;
		const commits = await branchCommits(branch.repoPath, branch.branch, branch.base);
		if (commits.length > 0) candidates.push({ branch, commits });
	}
	return candidates;
}

/** One repository's section on the page. Its text lives only here: closing the page discards it. */
interface Section extends PullRequestCandidate {
	/** Why this repository can't get a pull request from here, or null. */
	blocked: string | null;
	baseOptions: string[];
	base: string;
	draft: boolean;
	reviewers: string;
	shared: boolean;
	title: string;
	body: string;
	error: string | null;
	creating: boolean;
	created: PullRequest | null;
}

/** The Create PR page: a shared title and body, and one section per repository with commits. */
export class CreatePullRequestView extends ItemView {
	plugin: TheoryPlugin;
	private reportId: string | null = null;
	private loading = false;
	private sections: Section[] = [];
	private title = "";
	private body = "";
	// Body generations running, keyed by "shared" or the repository path.
	private generating = new Map<string, PullRequestBodyRun>();

	constructor(leaf: WorkspaceLeaf, plugin: TheoryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return CREATE_PR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Create PR";
	}

	getIcon(): string {
		return "git-pull-request";
	}

	getState(): Record<string, unknown> {
		return { reportId: this.reportId };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const reportId = (state as { reportId?: unknown })?.reportId;
		if (typeof reportId === "string" && reportId !== this.reportId) {
			this.reportId = reportId;
			await this.loadSections();
		}
		await super.setState(state, result);
	}

	async onOpen() {
		this.render();
	}

	async onClose() {
		for (const run of this.generating.values()) run.cancel();
		this.generating.clear();
	}

	private report(): CompileReport | undefined {
		return this.plugin.reports.find((r) => r.id === this.reportId);
	}

	private async loadSections() {
		const report = this.report();
		this.sections = [];
		if (!report) return this.render();
		this.loading = true;
		this.render();
		this.title = report.revisions[report.revisions.length - 1]?.subject ?? "";
		this.body = "";
		const candidates = await pullRequestCandidates(report, this.plugin.reports);
		const ghBlocked = candidates.length > 0 ? await ghProblem(candidates[0].branch.repoPath) : null;
		for (const candidate of candidates) {
			const { repoPath, base } = candidate.branch;
			const origin = await githubOrigin(repoPath);
			const remote = await remoteBranches(repoPath);
			this.sections.push({
				...candidate,
				blocked: !origin ? "This repository has no GitHub origin." : ghBlocked,
				baseOptions: remote.includes(base) ? remote : [base, ...remote],
				base,
				draft: false,
				reviewers: "",
				shared: true,
				title: "",
				body: "",
				error: null,
				creating: false,
				created: null,
			});
		}
		this.loading = false;
		this.render();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("theory-create-pr");
		const report = this.report();
		if (!report) {
			contentEl.createDiv({ cls: "theory-report-empty", text: "This compile's report is gone." });
			return;
		}
		contentEl.createEl("h3", { text: "Create pull requests" });
		if (this.loading) {
			contentEl.createDiv({ cls: "theory-report-empty", text: "Looking at the compile branches…" });
			return;
		}
		if (this.sections.length === 0) {
			contentEl.createDiv({ cls: "theory-report-empty", text: "No compile branch from this compile needs a pull request." });
			return;
		}

		const shared = contentEl.createDiv({ cls: "theory-create-pr-shared" });
		this.titleField(shared, this.title, (value) => (this.title = value));
		this.bodyField(shared, "shared", this.body, (value) => (this.body = value), this.sections.map((s) => s.branch.repo));

		for (const section of this.sections) this.renderSection(section);

		const ready = this.sections.filter((s) => !s.blocked && !s.created);
		const footer = contentEl.createDiv({ cls: "theory-create-pr-footer" });
		const create = footer.createEl("button", { cls: "mod-cta", text: "Create" });
		create.disabled = ready.length === 0 || ready.some((s) => s.creating);
		create.addEventListener("click", () => this.create());
	}

	private renderSection(section: Section) {
		const el = this.contentEl.createDiv({ cls: "theory-create-pr-section" });
		const header = el.createDiv({ cls: "theory-create-pr-header" });
		setIcon(header.createSpan({ cls: "theory-create-pr-icon" }), "git-branch");
		header.createSpan({ cls: "theory-create-pr-repo", text: section.branch.repo });
		header.createEl("code", { text: `${section.branch.branch} → ${section.base}` });

		const commits = el.createEl("ul", { cls: "theory-create-pr-commits" });
		for (const c of section.commits) commits.createEl("li", { text: `${c.hash.slice(0, 7)} ${c.subject}` });

		if (section.created) {
			const done = el.createDiv({ cls: "theory-report-meta" });
			done.appendText("Created ");
			done.createEl("a", { text: section.created.url, href: section.created.url });
			return;
		}
		if (section.blocked) {
			el.createDiv({ cls: "theory-create-pr-blocked", text: section.blocked });
			return;
		}

		new Setting(el).setName("Base").addDropdown((dropdown) => {
			for (const option of section.baseOptions) dropdown.addOption(option, option);
			dropdown.setValue(section.base).onChange((value) => {
				section.base = value;
				this.render();
			});
		});
		new Setting(el).setName("Draft").addToggle((toggle) => toggle.setValue(section.draft).onChange((value) => (section.draft = value)));
		new Setting(el)
			.setName("Reviewers")
			.setDesc("GitHub usernames, separated by commas.")
			.addText((text) => text.setValue(section.reviewers).onChange((value) => (section.reviewers = value)));
		new Setting(el).setName("Use the shared title and body").addToggle((toggle) =>
			toggle.setValue(section.shared).onChange((value) => {
				section.shared = value;
				// Its own title and body start from the shared ones.
				if (!value) {
					section.title = this.title;
					section.body = this.body;
				}
				this.render();
			}),
		);
		if (!section.shared) {
			this.titleField(el, section.title, (value) => (section.title = value));
			this.bodyField(el, section.branch.repoPath, section.body, (value) => (section.body = value), [section.branch.repo]);
		}
		if (section.error) el.createDiv({ cls: "theory-create-pr-error", text: `Couldn't create the pull request: ${section.error}` });
		if (section.creating) el.createDiv({ cls: "theory-report-meta", text: "Creating…" });
	}

	private titleField(container: HTMLElement, value: string, onChange: (value: string) => void) {
		const input = container.createEl("input", { cls: "theory-create-pr-title", attr: { type: "text", placeholder: "Title", "aria-label": "Title" } });
		input.value = value;
		input.addEventListener("input", () => onChange(input.value));
	}

	/** A body box with the sparkle that asks Claude to write it, the same as the commit message's. */
	private bodyField(container: HTMLElement, key: string, value: string, onChange: (value: string) => void, repos: string[]) {
		const box = container.createDiv({ cls: "theory-commit-message-box" });
		const text = box.createEl("textarea", {
			cls: "theory-commit-message theory-create-pr-body",
			attr: { rows: "8", placeholder: "Body", "aria-label": "Body" },
		});
		text.value = value;
		text.addEventListener("input", () => onChange(text.value));
		const generate = box.createEl("button", {
			cls: "clickable-icon theory-commit-generate",
			attr: { "aria-label": "Generate the body with Claude" },
		});
		setIcon(generate, "sparkles");
		const running = this.generating.has(key);
		generate.disabled = running;
		generate.toggleClass("is-loading", running);
		generate.addEventListener("click", async () => {
			const report = this.report();
			if (!report || this.generating.has(key)) return;
			const { claudeCommand, model, effort } = this.plugin.settings;
			const several = projectRepos(this.plugin.settings.projectFolder).length > 1;
			const run = generatePullRequestBody({ claudeCommand, model, effort, report, repos, several });
			this.generating.set(key, run);
			this.render();
			try {
				const generated = await run.done;
				// The generated text replaces the box's text.
				if (key === "shared") this.body = generated;
				else {
					const section = this.sections.find((s) => s.branch.repoPath === key);
					if (section) section.body = generated;
				}
			} catch (error) {
				if (this.generating.get(key) === run) {
					new Notice(`Couldn't generate the body: ${error instanceof Error ? error.message : String(error)}`, 10000);
				}
			}
			this.generating.delete(key);
			this.render();
		});
	}

	/** Pushes each ready compile branch and opens its pull request, then links them all to each other. */
	private async create() {
		const report = this.report();
		if (!report) return;
		const ready = this.sections.filter((s) => !s.blocked && !s.created && !s.creating);
		for (const section of ready) {
			section.creating = true;
			section.error = null;
		}
		this.render();
		for (const section of ready) {
			const title = (section.shared ? this.title : section.title).trim();
			const body = section.shared ? this.body : section.body;
			try {
				if (!title) throw new Error("The title is empty.");
				const reviewers = section.reviewers.split(",").map((r) => r.trim()).filter(Boolean);
				const url = await createPullRequest(section.branch.repoPath, {
					branch: section.branch.branch,
					base: section.base,
					title,
					body,
					draft: section.draft,
					reviewers,
				});
				section.created = {
					repoPath: section.branch.repoPath,
					repo: section.branch.repo,
					branch: section.branch.branch,
					base: section.base,
					url,
					state: section.draft ? "draft" : "open",
				};
				report.pullRequests = [...(report.pullRequests ?? []), section.created];
				await this.plugin.saveSettings();
			} catch (error) {
				// The section keeps its fields, so Create can be tried again.
				section.error = error instanceof Error ? error.message : String(error);
			}
			section.creating = false;
			this.render();
		}
		this.plugin.pullRequestsChanged();
		// A repository that can't get a pull request from here doesn't hold up the others.
		if (this.sections.filter((s) => !s.blocked).every((s) => s.created)) await this.addFooters(report);
	}

	/** Once every pull request exists, each body links the vault revisions compiled and the other pull requests. */
	private async addFooters(report: CompileReport) {
		const origin = await githubOrigin(this.plugin.getVaultPath());
		const revisions = report.revisions.map((r) => {
			const hash = r.hash.slice(0, 7);
			return `- ${origin ? `[${hash}](${origin}/commit/${r.hash})` : `\`${hash}\``} ${r.subject}`;
		});
		const prs = report.pullRequests ?? [];
		for (const pr of prs) {
			const others = prs.filter((p) => p !== pr).map((p) => `- ${p.repo}: ${p.url}`);
			const footer = [
				FOOTER_MARK,
				"---",
				"Compiled by theory.md from these revisions of the model:",
				...revisions,
				...(others.length > 0 ? ["", "Pull requests in the other repositories from the same compile:", ...others] : []),
			].join("\n");
			try {
				const current = await pullRequestBody(pr.repoPath, pr.url);
				const mark = current.indexOf(FOOTER_MARK);
				const body = (mark >= 0 ? current.slice(0, mark) : current).trimEnd();
				await editPullRequestBody(pr.repoPath, pr.url, body ? `${body}\n\n${footer}` : footer);
			} catch (error) {
				new Notice(`Couldn't link the pull request in ${pr.repo}: ${error instanceof Error ? error.message : String(error)}`, 10000);
			}
		}
		new Notice(prs.length === 1 ? "Created the pull request." : `Created ${prs.length} pull requests.`);
	}
}
