import { resolveTask } from "./agent-rows";
import { ItemView, Notice, Setting, ViewStateResult, WorkspaceLeaf, setIcon } from "obsidian";
import { projectRepos } from "./branches";
import { type PullRequestCandidate, epicPullRequestBody, pullRequestCandidates } from "./build";
import type { CompileReport } from "./compile";
import {
	PullRequest,
	createPullRequest,
	editPullRequestBody,
	existingPullRequest,
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

/** One repository's section on the page. Its text lives only here: closing the page discards it. */
interface Section extends PullRequestCandidate {
	/** Why this repository can't get a pull request from here, or null. */
	blocked: string | null;
	baseOptions: string[];
	base: string;
	draft: boolean;
	reviewers: string;
	title: string;
	body: string;
	error: string | null;
	creating: boolean;
	created: PullRequest | null;
	/** True when `created` was already on GitHub, not opened from this page (REP-58). */
	existing: boolean;
}

/** The Create PR page: one section per repository with commits, each with its own title and body (REP-26). */
export class CreatePullRequestView extends ItemView {
	plugin: TheoryPlugin;
	private reportId: string | null = null;
	private loading = false;
	private sections: Section[] = [];
	// Body generations running, keyed by the repository path.
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
		// A shared report from another machine joins plugin data, so its pull requests are kept (REP-50).
		return this.reportId === null ? undefined : this.plugin.adoptReport(this.reportId);
	}

	private async loadSections() {
		const report = this.report();
		this.sections = [];
		if (!report) return this.render();
		this.loading = true;
		this.render();
		const epic = report.issues?.find((i) => i.kind === "epic");
		const epicOrigin = epic ? await githubOrigin(epic.repoPath) : null;
		const epicRepoName = epicOrigin ? epicOrigin.replace("https://github.com/", "") : null;
		// Every title starts as the epic's. Each body refers to the epic as its repository must (REP-27, BLD-26).
		const title = epic?.title ?? report.revisions[report.revisions.length - 1]?.subject ?? "";
		const candidates = await pullRequestCandidates(report);
		const ghBlocked = candidates.length > 0 ? await ghProblem(candidates[0].branch.repoPath) : null;
		for (const candidate of candidates) {
			const { repoPath, base } = candidate.branch;
			const origin = await githubOrigin(repoPath);
			const remote = await remoteBranches(repoPath);
			const repoName = origin ? origin.replace("https://github.com/", "") : null;
			const body = epicPullRequestBody(report, repoName, epicRepoName);
			this.sections.push({
				...candidate,
				blocked: !origin ? "This repository has no GitHub origin." : ghBlocked,
				baseOptions: remote.includes(base) ? remote : [base, ...remote],
				base,
				draft: false,
				reviewers: "",
				title,
				body,
				error: null,
				creating: false,
				created: null,
				existing: false,
			});
		}
		// A branch that already has a pull request shows it instead of a form (REP-58).
		for (const section of this.sections) {
			if (!section.blocked) await this.adoptExisting(report, section);
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
			contentEl.createDiv({ cls: "theory-report-empty", text: "Looking at the epic branches…" });
			return;
		}
		if (this.sections.length === 0) {
			contentEl.createDiv({ cls: "theory-report-empty", text: "No epic branch from this build needs a pull request." });
			return;
		}

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
			done.appendText(section.existing ? `Already has a pull request (${section.created.state}): ` : "Created ");
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
		this.titleField(el, section.title, (value) => (section.title = value));
		this.bodyField(el, section, (value) => (section.body = value));
		if (section.error) el.createDiv({ cls: "theory-create-pr-error", text: `Couldn't create the pull request: ${section.error}` });
		if (section.creating) el.createDiv({ cls: "theory-report-meta", text: "Creating…" });
	}

	private titleField(container: HTMLElement, value: string, onChange: (value: string) => void) {
		const input = container.createEl("input", { cls: "theory-create-pr-title", attr: { type: "text", placeholder: "Title", "aria-label": "Title" } });
		input.value = value;
		input.addEventListener("input", () => onChange(input.value));
	}

	/**
	 * A section's body box with the sparkle that asks Claude to write it, the same as the commit message's. Claude gets
	 * only that repository's changes (REP-28).
	 */
	private bodyField(container: HTMLElement, section: Section, onChange: (value: string) => void) {
		const key = section.branch.repoPath;
		const box = container.createDiv({ cls: "theory-commit-message-box" });
		const text = box.createEl("textarea", {
			cls: "theory-commit-message theory-create-pr-body",
			attr: { rows: "8", placeholder: "Body", "aria-label": "Body" },
		});
		text.value = section.body;
		text.addEventListener("input", () => onChange(text.value));
		const generate = box.createEl("button", {
			cls: "clickable-icon theory-commit-generate",
			attr: { "aria-label": "Generate the body with Claude" },
		});
		setIcon(generate, "sparkles");
		const running = this.generating.has(key);
		generate.disabled = running;
		generate.toggleClass("is-generating", running);
		generate.addEventListener("click", async () => {
			const report = this.report();
			if (!report || this.generating.has(key)) return;
			const { claudeCommand } = this.plugin.settings;
			const { model, effort } = resolveTask(this.plugin.settings.tasks, "writing");
			const several = projectRepos(this.plugin.settings.projectFolder).length > 1;
			const run = generatePullRequestBody({ claudeCommand, model, effort, report, repo: section.branch.repo, several });
			this.generating.set(key, run);
			this.render();
			try {
				const generated = await run.done;
				// The generated text replaces the box's text.
				section.body = generated;
			} catch (error) {
				if (this.generating.get(key) === run) {
					new Notice(`Couldn't generate the body: ${error instanceof Error ? error.message : String(error)}`, 10000);
				}
			}
			this.generating.delete(key);
			this.render();
		});
	}

	/** Pushes each ready epic branch and opens its pull request, then links them all to each other. */
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
			const title = section.title.trim();
			const body = section.body;
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
				// A pull request opened meanwhile, elsewhere, is shown instead of the error (REP-58).
				if (!(await this.adoptExisting(report, section))) {
					// The section keeps its fields, so Create can be tried again.
					section.error = error instanceof Error ? error.message : String(error);
				}
			}
			section.creating = false;
			this.render();
		}
		// Pull requests that Create PR opened are shared once it ends (REP-46, REP-47).
		if (ready.some((s) => s.created)) await this.plugin.shareReport(report, "pull-requests");
		this.plugin.pullRequestsChanged();
		// A repository that can't get a pull request from here doesn't hold up the others.
		if (this.sections.filter((s) => !s.blocked).every((s) => s.created)) await this.addFooters(report);
	}

	/**
	 * When the section's branch already has an open, draft or merged pull request on GitHub, the section shows it
	 * and the report keeps it, with a notice, so Create never tries to open a second one (REP-58).
	 */
	private async adoptExisting(report: CompileReport, section: Section): Promise<boolean> {
		const found = await existingPullRequest(section.branch.repoPath, section.branch.branch);
		if (!found) return false;
		section.created = {
			repoPath: section.branch.repoPath,
			repo: section.branch.repo,
			branch: section.branch.branch,
			base: section.base,
			url: found.url,
			state: found.state,
		};
		section.existing = true;
		section.error = null;
		report.pullRequests = [...(report.pullRequests ?? []), section.created];
		await this.plugin.saveSettings();
		this.plugin.pullRequestsChanged();
		new Notice(`${section.branch.repo} already has a pull request (${found.state}): ${found.url}`, 10000);
		return true;
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
		// Pull requests that were already on GitHub (REP-58) had their own notice.
		const opened = this.sections.filter((s) => s.created && !s.existing).length;
		if (opened > 0) new Notice(opened === 1 ? "Created the pull request." : `Created ${opened} pull requests.`);
	}
}
