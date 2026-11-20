import { resolveTask } from "./agent-rows";
import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type { Anchor } from "./anchor";
import {
	timeLeft,
	type CompileReport,
	type CompileStatus,
	type PermissionAnswer,
	type PermissionRequest,
	type Question,
} from "./compile";
import { buildPromptText, pullRequestCandidates, type BuildStatus } from "./build";
import type { BuildState, IssueRecord } from "./plan";
import type { PullRequestState } from "./github";
import type TheoryPlugin from "./main";
import type { BuildChoice } from "./build";
import { startSuggest, type SuggestRun } from "./suggest";

export const REPORT_VIEW_TYPE = "theory-compile-report";

export const STATUS_TEXT:Record<CompileStatus, string> = {
	running: "Compiling…",
	succeeded: "Compiled",
	failed: "Failed",
	cancelled: "Cancelled",
};

export const STATUS_ICON:Record<CompileStatus, string> = {
	running: "loader",
	succeeded: "check-circle",
	failed: "alert-triangle",
	cancelled: "x-circle",
};

/** An issue's build state as the report shows it (BLD-3). */
export const BUILD_STATE_TEXT: Record<BuildState, string> = {
	waiting: "Waiting",
	building: "Building…",
	built: "Built",
	skipped: "Skipped",
	failed: "Failed",
};

export const BUILD_STATUS_TEXT: Record<BuildStatus, string> = {
	running: "Building…",
	finished: "Build finished",
	stopped: "Build stopped",
	cancelled: "Build cancelled",
};

export const PR_STATE_TEXT: Record<PullRequestState, string> = {
	draft: "Draft",
	open: "Open",
	merged: "Merged",
	closed: "Closed",
};

function shortHash(hash: string | null): string {
	return hash ? hash.slice(0, 7) : "start";
}

/** A suggestion for one question. It lives only on screen: never in the report, plugin data or the vault. */
type SuggestionState =
	| { state: "running"; run: SuggestRun }
	| { state: "shown"; text: string; why: string }
	| { state: "failed"; reason: string };

/** Where Reply and Accept open the note: the first anchor, else the top of the first note. */
function questionTarget(q: Question): Anchor | undefined {
	return q.anchors?.[0] ?? (q.notes[0] ? { path: q.notes[0] } : undefined);
}

/** Shows compile reports. They live in plugin data, never in the model. */
export class CompileReportView extends ItemView {
	plugin: TheoryPlugin;
	// The report on screen; null follows the newest one.
	private selectedId: string | null = null;
	private activityOpen = false;
	// Deny buttons on the permission cards on screen, with the time each request is denied by itself.
	private countdowns: { el: HTMLElement; expiresAt: number }[] = [];
	// Suggestions on screen, keyed by report id and question index. Closing the report discards them.
	private suggestions = new Map<string, SuggestionState>();
	// How many repositories of each finished report still need a pull request, worked out from git and gh.
	private candidates = new Map<string, number>();
	// The report last drawn. Switching to another report refreshes the pull request states.
	private drawnId: string | null = null;
	// Reports whose "Build them now?" got Later. Only on screen: the Build button stays (BLD-1).
	private later = new Set<string>();

	constructor(leaf: WorkspaceLeaf, plugin: TheoryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return REPORT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Compile report";
	}

	getIcon(): string {
		return "hammer";
	}

	async onOpen() {
		this.registerInterval(window.setInterval(() => this.tick(), 1000));
		this.refresh();
	}

	/** Forgets which reports need a pull request, e.g. after one was created, so the next draw looks again. */
	forgetPullRequests() {
		this.candidates.clear();
		this.refresh();
	}

	async onClose() {
		this.drawnId = null;
		this.candidates.clear();
		for (const s of this.suggestions.values()) if (s.state === "running") s.run.cancel();
		this.suggestions.clear();
	}

	/** Shows the newest report, e.g. when a compile starts. */
	showLatest() {
		this.selectedId = null;
		this.refresh();
	}

	/** Shows one report, e.g. when it's picked in the compile history. */
	show(id: string) {
		this.selectedId = this.plugin.reports[0]?.id === id ? null : id;
		this.refresh();
	}

	refresh() {
		const reports = this.plugin.reports;
		const report = reports.find((r) => r.id === this.selectedId) ?? reports[0];
		const { contentEl } = this;
		// A suggestion box being edited keeps its focus and cursor across redraws.
		const focused = document.activeElement;
		const editing =
			focused instanceof HTMLTextAreaElement && contentEl.contains(focused)
				? { key: focused.dataset.suggestion, start: focused.selectionStart, end: focused.selectionEnd }
				: null;
		contentEl.empty();
		contentEl.addClass("theory-report");
		this.countdowns = [];

		const toolbar = contentEl.createDiv({ cls: "theory-report-toolbar" });
		if (reports.length > 0) {
			const select = toolbar.createEl("select", { cls: "dropdown", attr: { "aria-label": "Past compiles" } });
			for (const r of reports) {
				const label = `${new Date(r.startedAt).toLocaleString()} · ${STATUS_TEXT[r.status]}`;
				select.createEl("option", { value: r.id, text: label });
			}
			select.value = report.id;
			select.addEventListener("change", () => {
				this.selectedId = select.value === reports[0].id ? null : select.value;
				this.refresh();
			});
		}
		const compile = toolbar.createEl("button", { cls: "mod-cta", text: "Compile" });
		compile.disabled = this.plugin.isCompiling();
		compile.addEventListener("click", () => this.plugin.compile());

		if (!report) {
			contentEl.createDiv({
				cls: "theory-report-empty",
				text: "No compiles yet. Commit your changes to the model, then click Compile.",
			});
			return;
		}
		this.renderReport(report);
		this.checkPullRequests(report);
		if (editing?.key) {
			const box = contentEl.querySelector<HTMLTextAreaElement>(`textarea[data-suggestion="${editing.key}"]`);
			box?.focus();
			box?.setSelectionRange(editing.start, editing.end);
		}
	}

	private renderReport(report: CompileReport) {
		const { contentEl } = this;

		const header = contentEl.createDiv({ cls: `theory-report-status is-${report.status}` });
		setIcon(header.createSpan({ cls: "theory-report-status-icon" }), STATUS_ICON[report.status]);
		header.createSpan({ text: STATUS_TEXT[report.status] });
		header.createSpan({
			cls: "theory-report-range",
			text: `${shortHash(report.fromCommit)} → ${shortHash(report.toCommit)}`,
		});
		const building = report.build?.status === "running";
		if (report.status === "running" || building) {
			header
				.createEl("button", { cls: "theory-report-cancel", text: "Cancel" })
				.addEventListener("click", () => this.plugin.cancelCompile());
		} else if (this.plugin.overlay.report() === report) {
			header
				.createEl("button", { cls: "theory-report-cancel", text: "Clear highlights" })
				.addEventListener("click", () => this.plugin.overlay.dismiss());
		}
		// Shown once a build finished an epic whose branches have commits and no pull request yet (REP-25).
		if (report.status !== "running" && (this.candidates.get(report.id) ?? 0) > 0) {
			const create = header.createEl("button", { cls: "theory-report-cancel theory-report-create-pr", text: "Create PR" });
			setIcon(create.createSpan({ cls: "theory-report-reply-icon" }), "git-pull-request");
			create.addEventListener("click", () => this.plugin.openCreatePullRequests(report.id));
		}

		if (report.summary) contentEl.createEl("p", { cls: "theory-report-summary", text: report.summary });

		this.renderIssueFailure(report);
		this.renderBuild(report);
		this.renderIssues(report);

		if (report.pullRequests?.length) {
			const section = this.section("Pull requests", report.pullRequests.length);
			for (const pr of report.pullRequests) {
				const item = section.createDiv({ cls: "theory-report-pr" });
				item.createSpan({ cls: "theory-report-pr-repo", text: pr.repo });
				item.createEl("a", { text: pr.url, href: pr.url });
				item.createSpan({ cls: `theory-pr-state is-${pr.state}`, text: PR_STATE_TEXT[pr.state] });
			}
		}

		if (report.problems.length > 0) {
			const section = this.section("Problems", report.problems.length);
			const list = section.createEl("ul", { cls: "theory-report-problems" });
			for (const problem of report.problems) {
				const item = list.createEl("li");
				item.createDiv({ text: problem.text });
				if (problem.anchors.length > 0) this.anchorLinks(item, problem.anchors);
			}
		}

		const anchored = report.problems.some((p) => p.anchors.length > 0);
		if (report.status === "failed" && !anchored && report.suspectNotes?.length) {
			const section = this.section("Notes changed in this compile", report.suspectNotes.length);
			section.createDiv({
				cls: "theory-report-meta",
				text: "Claude didn't say where in the model the compile failed. One of these notes may be the cause.",
			});
			this.anchorLinks(section, report.suspectNotes.map((path) => ({ path })));
		}

		if (report.questions.length > 0) {
			const section = this.section("Questions about the model", report.questions.length);
			report.questions.forEach((q, index) => {
				const item = section.createDiv({ cls: "theory-report-question" });
				const row = item.createDiv({ cls: "theory-report-question-row" });
				row.createDiv({ text: q.question });
				// Reply opens the note at the rule that needs updating, else its heading, else the top. Engineers answer in the model.
				const target = questionTarget(q);
				if (target) {
					const buttons = row.createDiv({ cls: "theory-report-question-buttons" });
					const reply = buttons.createEl("button", { cls: "theory-report-reply", text: "Reply" });
					setIcon(reply.createSpan({ cls: "theory-report-reply-icon" }), "reply");
					reply.setAttr("aria-label", `Open ${target.path} at the rule this question is about`);
					reply.addEventListener("click", () => this.plugin.overlay.jump(target));
					this.suggestButton(buttons, report, q, `${report.id}:${index}`);
				}
				if (q.notes.length > 0) {
					const notes = item.createDiv({ cls: "theory-report-notes" });
					for (const note of q.notes) {
						const link = notes.createEl("a", { cls: "internal-link", text: note, href: note });
						link.addEventListener("click", (event) => {
							event.preventDefault();
							this.app.workspace.openLinkText(note, "", false);
						});
					}
				}
				this.suggestionBox(item, q, `${report.id}:${index}`);
			});
		}

		if (report.changes.length > 0) {
			const section = this.section("Changes to the code", report.changes.length);
			const list = section.createEl("ul");
			for (const change of report.changes) list.createEl("li", { text: change });
		}

		const revisions = this.section("Revisions compiled", report.revisions.length);
		for (const r of report.revisions) {
			const item = revisions.createDiv({ cls: "theory-report-revision" });
			item.createDiv({ text: r.subject });
			item.createDiv({
				cls: "theory-report-meta",
				text: `${r.author} · ${new Date(r.date).toLocaleString()} · ${r.hash.slice(0, 7)}`,
			});
		}

		if (report.log.length === 0 && report.status !== "running" && !building) return;
		// Waiting permission requests show as cards on their own line of the log, in the report that runs.
		const waiting = this.plugin.activeReportId() === report.id ? this.plugin.permissionRequests() : [];
		const cardAt = new Map(waiting.map((request) => [request.line, request]));
		// Folded until the engineer opens it, and kept that way as new lines arrive. Open while a card waits.
		const details = contentEl.createEl("details", { cls: "theory-report-log" });
		details.open = this.activityOpen || waiting.length > 0;
		details.addEventListener("toggle", () => {
			if (waiting.length === 0) this.activityOpen = details.open;
		});
		details.createEl("summary", { text: `Activity (${report.log.length})` });
		const lines = details.createDiv({ cls: "theory-report-log-lines" });
		if (report.log.length === 0) lines.createEl("pre", { text: "Waiting for Claude…" });
		let chunk: string[] = [];
		const flush = () => {
			if (chunk.length > 0) lines.createEl("pre", { text: chunk.join("\n") });
			chunk = [];
		};
		const cards: HTMLElement[] = [];
		report.log.forEach((line, index) => {
			const request = cardAt.get(index);
			if (!request) {
				chunk.push(line);
				return;
			}
			flush();
			cards.push(this.permissionCard(lines, request));
		});
		flush();
		this.tick();
		// Scrolled to the oldest waiting card.
		const [card] = cards;
		if (card) window.requestAnimationFrame(() => card.scrollIntoView({ block: "nearest" }));
	}

	/**
	 * Refreshes the pull request states when the report opens or another report is shown, and works out,
	 * once per report on screen, whether Create PR shows. Both need git or gh, so they redraw when done.
	 */
	private async checkPullRequests(report: CompileReport) {
		if (this.drawnId !== report.id) {
			this.drawnId = report.id;
			this.plugin.refreshPullRequestStates("report");
		}
		if (report.status === "running" || report.build?.status !== "finished") return;
		if (this.candidates.has(report.id)) return;
		this.candidates.set(report.id, 0);
		const found = await pullRequestCandidates(report).catch(() => []);
		this.candidates.set(report.id, found.length);
		if (found.length > 0) this.refresh();
	}

	/** CMP-68: creating an issue failed, and the compile waits for Retry or Discard. */
	private renderIssueFailure(report: CompileReport) {
		if (!report.issueFailure || report.status !== "running") return;
		const card = this.contentEl.createDiv({ cls: "theory-permission-card theory-build-question" });
		card.createDiv({ cls: "theory-permission-title", text: report.issueFailure });
		card.createDiv({
			cls: "theory-report-meta",
			text: "Retry creates the issues still missing. Discard closes the issues already created as not planned, and the last compile marker doesn't move.",
		});
		const buttons = card.createDiv({ cls: "theory-permission-buttons" });
		buttons.createEl("button", { cls: "mod-cta", text: "Retry" }).addEventListener("click", () => this.plugin.retryIssues());
		buttons.createEl("button", { text: "Discard" }).addEventListener("click", () => this.plugin.discardIssues());
	}

	/** The build: "Build them now?", the Build button, its status and message, and what it waits on (BLD-1, BLD-17, BLD-22, BLD-23, BLD-28). */
	private renderBuild(report: CompileReport) {
		const issues = (report.issues ?? []).filter((i) => i.kind === "issue" && i.number !== undefined);
		if (report.status !== "succeeded" || issues.length === 0) return;
		const build = report.build;
		const busy = this.plugin.isCompiling();
		const section = this.contentEl.createDiv({ cls: "theory-report-build" });
		if (!build && !this.later.has(report.id)) {
			const ask = section.createDiv({ cls: "theory-permission-card theory-build-question" });
			ask.createDiv({ cls: "theory-permission-title", text: buildPromptText(report) });
			const buttons = ask.createDiv({ cls: "theory-permission-buttons" });
			const now = buttons.createEl("button", { cls: "mod-cta", text: "Build" });
			now.disabled = busy;
			now.addEventListener("click", () => this.plugin.build(report.id));
			buttons.createEl("button", { text: "Later" }).addEventListener("click", () => {
				this.later.add(report.id);
				this.refresh();
			});
			return;
		}
		const row = section.createDiv({ cls: "theory-report-build-row" });
		if (build) row.createSpan({ cls: `theory-report-build-status is-${build.status}`, text: BUILD_STATUS_TEXT[build.status] });
		const left = issues.some((i) => i.build !== "built");
		if (build?.status !== "running" && left) {
			const button = row.createEl("button", { cls: "mod-cta", text: "Build" });
			button.disabled = busy;
			button.addEventListener("click", () => this.plugin.build(report.id));
		}
		if (build?.message) section.createEl("p", { cls: "theory-report-summary", text: build.message });
		// BLD-28: the sub-issues a finished epic build skipped, still open.
		if (build?.skippedLine) section.createEl("p", { cls: "theory-report-summary", text: build.skippedLine });

		const waiting = build?.status === "running" ? build.waiting : undefined;
		if (!waiting) return;
		const issue = report.issues?.[waiting.issue];
		const card = section.createDiv({ cls: "theory-permission-card theory-build-question" });
		const name = issue ? `${issue.repo}#${issue.number}` : "The issue";
		const buttons = (choices: [BuildChoice, string][]) => {
			const el = card.createDiv({ cls: "theory-permission-buttons" });
			for (const [choice, text] of choices) {
				el.createEl("button", { text, cls: choice === "retry" || choice === "keep" ? "mod-cta" : "" }).addEventListener("click", () =>
					this.plugin.chooseInBuild(choice),
				);
			}
		};
		if (waiting.kind === "failure") {
			card.createDiv({ cls: "theory-permission-title", text: `${name} failed.` });
			card.createDiv({ cls: "theory-report-meta", text: waiting.reason });
			buttons([["retry", "Retry"], ...(waiting.canSkip ? [["skip", "Skip"] as [BuildChoice, string]] : []), ["stop", "Stop"]]);
		} else {
			card.createDiv({ cls: "theory-permission-title", text: `Keep ${waiting.branch}?` });
			card.createDiv({ cls: "theory-report-meta", text: `You cancelled the build of ${name}. Keep its branch, or delete it.` });
			buttons([
				["keep", "Keep branch"],
				["delete", "Delete branch"],
			]);
		}
	}

	/** REP-40: the issues this compile created, the epic first, with their build state. */
	private renderIssues(report: CompileReport) {
		const issues = report.issues ?? [];
		if (issues.length === 0) return;
		const section = this.section("Issues", issues.length);
		for (const issue of issues) this.issueRow(section, issue);
	}

	private issueRow(container: HTMLElement, issue: IssueRecord) {
		const item = container.createDiv({ cls: `theory-report-issue is-${issue.kind}` });
		item.createSpan({ cls: "theory-report-pr-repo", text: issue.number !== undefined ? `${issue.repo}#${issue.number}` : issue.repo });
		if (issue.url) item.createEl("a", { text: issue.title, href: issue.url });
		else item.createSpan({ text: `${issue.title} (not created)` });
		if (issue.kind === "epic") item.createSpan({ cls: "theory-pr-state is-epic", text: "Epic" });
		else if (issue.discarded) item.createSpan({ cls: "theory-pr-state is-closed", text: "Discarded" });
		else if (issue.build) item.createSpan({ cls: `theory-pr-state is-build-${issue.build}`, text: BUILD_STATE_TEXT[issue.build] });
		if (issue.branch) item.createEl("code", { cls: "theory-report-meta", text: issue.branch });
	}

	/** Suggest asks Claude for ideas on answering the question. One question has at most one suggestion at a time. */
	private suggestButton(container: HTMLElement, report: CompileReport, q: Question, key: string) {
		const current = this.suggestions.get(key);
		const running = current?.state === "running";
		const button = container.createEl("button", { cls: "theory-report-suggest", text: running ? "Suggesting…" : "Suggest" });
		setIcon(button.createSpan({ cls: "theory-report-reply-icon" }), "sparkles");
		button.disabled = running || current?.state === "shown";
		button.addEventListener("click", () => this.suggest(report, q, key));
	}

	private async suggest(report: CompileReport, q: Question, key: string) {
		if (this.suggestions.get(key)?.state === "running") return;
		const { claudeCommand } = this.plugin.settings;
		const { model, effort } = resolveTask(this.plugin.settings.tasks, "writing");
		// The current text of every note the question names, uncommitted edits included.
		const paths = [...new Set([...q.notes, ...(q.anchors ?? []).map((a) => a.path)])];
		const notes = new Map<string, string | null>();
		for (const path of paths) {
			const file = this.app.vault.getAbstractFileByPath(path);
			notes.set(path, file instanceof TFile ? await this.app.vault.read(file) : null);
		}
		const run = startSuggest({ claudeCommand, model, effort, question: q, summary: report.summary, notes });
		this.suggestions.set(key, { state: "running", run });
		this.refresh();
		try {
			const suggestion = await run.done;
			if (this.suggestions.get(key)?.state !== "running") return;
			this.suggestions.set(key, { state: "shown", ...suggestion });
		} catch (error) {
			if (this.suggestions.get(key)?.state !== "running") return;
			const reason = error instanceof Error ? error.message : String(error);
			this.suggestions.set(key, { state: "failed", reason });
		}
		this.refresh();
	}

	/** The suggestion under its question: the spot it is for, an editable box, why, Accept and Reject. */
	private suggestionBox(container: HTMLElement, q: Question, key: string) {
		const current = this.suggestions.get(key);
		if (!current || current.state === "running") return;
		const box = container.createDiv({ cls: "theory-suggestion" });
		if (current.state === "failed") {
			box.createDiv({ cls: "theory-suggestion-error", text: `Couldn't get a suggestion: ${current.reason}` });
			return;
		}
		const target = questionTarget(q);
		if (target) {
			box.createDiv({
				cls: "theory-report-meta",
				text: `Suggestion for ${target.heading ? `${target.path} › ${target.heading}` : target.path}`,
			});
		}
		const text = box.createEl("textarea", { cls: "theory-suggestion-text", attr: { "data-suggestion": key, rows: "6" } });
		text.value = current.text;
		text.addEventListener("input", () => (current.text = text.value));
		if (current.why) box.createDiv({ cls: "theory-report-meta", text: current.why });
		const buttons = box.createDiv({ cls: "theory-suggestion-buttons" });
		// Accept never writes to a note: the engineer writes the words themselves.
		buttons.createEl("button", { cls: "mod-cta", text: "Accept" }).addEventListener("click", async () => {
			await navigator.clipboard.writeText(text.value);
			if (target) await this.plugin.overlay.jump(target);
			new Notice("Suggestion copied. Write it in the note in your own words.");
		});
		buttons.createEl("button", { text: "Reject" }).addEventListener("click", () => {
			this.suggestions.delete(key);
			this.refresh();
		});
	}

	/** A card for one waiting permission request, answered on its own. */
	private permissionCard(container: HTMLElement, request: PermissionRequest): HTMLElement {
		const card = container.createDiv({ cls: "theory-permission-card" });
		const title = card.createDiv({ cls: "theory-permission-title" });
		setIcon(title.createSpan({ cls: "theory-permission-icon" }), "shield-question");
		title.createSpan({ text: request.tool });
		card.createEl("pre", { cls: "theory-permission-target", text: request.target });
		card.createDiv({ cls: "theory-report-meta", text: request.reason });
		// The engineer sees how much one click allows before clicking Always allow.
		if (request.sessionOnly) {
			card.createDiv({
				cls: "theory-report-meta theory-permission-rule",
				text: "Always allow lasts for this compile only. It doesn't change Allowed commands.",
			});
		} else if (request.rules.length > 0) {
			const rule = card.createDiv({ cls: "theory-report-meta theory-permission-rule" });
			rule.appendText("Always allow adds ");
			request.rules.forEach((text, i) => {
				if (i > 0) rule.appendText(i === request.rules.length - 1 ? " and " : ", ");
				rule.createEl("code", { text });
			});
			rule.appendText(" to Allowed commands.");
		}
		const buttons = card.createDiv({ cls: "theory-permission-buttons" });
		const choices: [PermissionAnswer, string][] = [
			["allow", "Allow"],
			["always", "Always allow"],
			["deny", "Deny"],
		];
		for (const [answer, text] of choices) {
			if (answer === "always" && request.rules.length === 0 && !request.sessionOnly) continue;
			const button = buttons.createEl("button", { text, cls: answer === "allow" ? "mod-cta" : "" });
			if (answer === "deny") this.countdowns.push({ el: button, expiresAt: request.expiresAt });
			button.addEventListener("click", () => this.plugin.answerPermission(request.id, answer));
		}
		return card;
	}

	/** Counts down the time left on each Deny button, from "Deny (2:00)" to "Deny (0:00)". */
	private tick() {
		for (const { el, expiresAt } of this.countdowns) {
			el.setText(`Deny (${timeLeft(expiresAt)})`);
		}
	}

	/** Links that open each anchor's note at the spot it names. */
	private anchorLinks(container: HTMLElement, anchors: Anchor[]) {
		const links = container.createDiv({ cls: "theory-report-notes" });
		for (const anchor of anchors) {
			const text = anchor.heading ? `${anchor.path} › ${anchor.heading}` : anchor.path;
			const link = links.createEl("a", { cls: "internal-link", text, href: anchor.path });
			if (anchor.quote) link.setAttr("title", anchor.quote);
			link.addEventListener("click", (event) => {
				event.preventDefault();
				this.plugin.overlay.jump(anchor);
			});
		}
	}

	private section(title: string, count: number): HTMLElement {
		const section = this.contentEl.createDiv({ cls: "theory-report-section" });
		section.createEl("h4", { text: `${title} (${count})` });
		return section;
	}
}
