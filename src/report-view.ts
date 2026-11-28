import { resolveTask } from "./agent-rows";
import { codeSourceText } from "./code-snapshot";
import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type { Anchor } from "./anchor";
import {
	pendingRevisionCount,
	timeLeft,
	type CompileReport,
	type CompileStatus,
	type PermissionAnswer,
	type PermissionRequest,
	type Question,
} from "./compile";
import { buildPromptText, pullRequestCandidates, type BuildStatus } from "./build";
import type { BuildState, IssueRecord } from "./plan";
import { canDiscard, stepsLeft } from "./plan";
import type { PullRequestState } from "./github";
import type TheoryPlugin from "./main";
import type { BuildChoice } from "./build";
import { issueFate, issueOrigin, recompileButton, recompiledBy, recompiledReport } from "./recompile";
import { startSuggest, type SuggestRun } from "./suggest";
import { ONLY_HERE, STATUS_TEXT, type ReportEntry, entryId, entryLabel } from "./report-list";
import { COMPILED_MEANWHILE, NO_ACTIVITY_LOG, readActivityLog } from "./shared-report";

export const REPORT_VIEW_TYPE = "theory-compile-report";

export { STATUS_TEXT };

export const STATUS_ICON:Record<CompileStatus, string> = {
	running: "loader",
	succeeded: "check-circle",
	failed: "alert-triangle",
	cancelled: "x-circle",
	imported: "import",
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
	// Pending revisions as last counted, for Recompile (CMP-74). Null until counted.
	private pending: number | null = null;
	// The shared Activity logs of reports from `.compiles/`, by file: their lines, or null when there is none (REP-54).
	private sharedLogs = new Map<string, string[] | null>();

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
		// Teammates' compiles may have arrived since `.compiles/` was last read (REP-51).
		await this.plugin.loadSharedReports();
	}

	/** Forgets which reports need a pull request, e.g. after one was created, so the next draw looks again. */
	forgetPullRequests() {
		this.candidates.clear();
		this.refresh();
	}

	async onClose() {
		this.drawnId = null;
		this.candidates.clear();
		this.sharedLogs.clear();
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
		const [newest] = this.plugin.reportEntries();
		this.selectedId = newest && entryId(newest) === id ? null : id;
		this.refresh();
	}

	refresh() {
		// The reports in plugin data and the shared ones in `.compiles/`, newest first (REP-51).
		const entries = this.plugin.reportEntries();
		const entry: ReportEntry | undefined = entries.find((e) => entryId(e) === this.selectedId) ?? entries[0];
		const report = entry?.kind === "report" ? entry.report : undefined;
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
		if (entry) {
			const select = toolbar.createEl("select", { cls: "dropdown", attr: { "aria-label": "Past compiles" } });
			for (const e of entries) select.createEl("option", { value: entryId(e), text: entryLabel(e) });
			select.value = entryId(entry);
			select.addEventListener("change", () => {
				this.selectedId = select.value === entryId(entries[0]) ? null : select.value;
				this.refresh();
			});
		}
		const compile = toolbar.createEl("button", { cls: "mod-cta", text: "Compile" });
		compile.disabled = this.plugin.isCompiling();
		compile.addEventListener("click", () => this.plugin.compile());

		if (entry?.kind === "broken") {
			// REP-52: never overwritten, and never counted for the marker.
			contentEl.createDiv({ cls: "theory-report-empty", text: `Can't read ${entry.file}` });
			contentEl.createDiv({
				cls: "theory-report-meta",
				text: "The plugin never overwrites this file, and it doesn't count for the last compile marker. Fix or remove it in git.",
			});
			return;
		}
		if (!report || entry?.kind !== "report") {
			contentEl.createDiv({
				cls: "theory-report-empty",
				text: "No compiles yet. Commit your changes to the model, then click Compile.",
			});
			return;
		}
		this.renderReport(report, entry.onlyHere);
		this.checkPullRequests(report);
		this.countPending();
		if (editing?.key) {
			const box = contentEl.querySelector<HTMLTextAreaElement>(`textarea[data-suggestion="${editing.key}"]`);
			box?.focus();
			box?.setSelectionRange(editing.start, editing.end);
		}
	}

	private renderReport(report: CompileReport, onlyHere: boolean) {
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

		// REP-51: who compiled a shared report, or that this one is only on this machine.
		contentEl.createDiv({
			cls: "theory-report-meta theory-report-origin",
			text: onlyHere ? ONLY_HERE : report.author ? `Compiled by ${report.author}` : "Shared in .compiles/",
		});
		// CMP-91: a teammate compiled the same revisions at the same time. The engineers decide which plan to build.
		if (report.compiledMeanwhile) {
			const card = contentEl.createDiv({ cls: "theory-permission-card theory-build-question" });
			card.createDiv({ cls: "theory-permission-title", text: COMPILED_MEANWHILE });
			card.createDiv({ cls: "theory-report-meta", text: `The other report: ${report.compiledMeanwhile}` });
		}

		if (report.summary) contentEl.createEl("p", { cls: "theory-report-summary", text: report.summary });

		this.renderRecompileLinks(report);
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

		// The code each repository was read at, linked to its commit on GitHub (REP-43).
		if (report.code && report.code.length > 0) {
			const code = this.section("Code read", report.code.length);
			for (const read of report.code) {
				const item = code.createDiv({ cls: "theory-report-revision" });
				const line = item.createDiv();
				line.createSpan({ text: `${read.repo}: ${read.branch} at ` });
				const short = read.commit.slice(0, 7);
				if (read.url) line.createEl("a", { text: short, href: read.url });
				else line.createSpan({ text: short });
				const source = codeSourceText(read);
				if (source) line.createSpan({ cls: "theory-report-meta", text: ` · ${source}` });
			}
		}

		// REP-54: a report from `.compiles/` shows the shared Activity log, then what this machine's builds added.
		const shared = report.fromShared ? this.sharedLog(report) : undefined;
		if (shared === undefined && report.log.length === 0 && report.status !== "running" && !building) return;
		// Waiting permission requests show as cards on their own line of the log, in the report that runs.
		const waiting = this.plugin.activeReportId() === report.id ? this.plugin.permissionRequests() : [];
		const cardAt = new Map(waiting.map((request) => [request.line, request]));
		// Folded until the engineer opens it, and kept that way as new lines arrive. Open while a card waits.
		const details = contentEl.createEl("details", { cls: "theory-report-log" });
		details.open = this.activityOpen || waiting.length > 0;
		details.addEventListener("toggle", () => {
			if (waiting.length === 0) this.activityOpen = details.open;
		});
		details.createEl("summary", { text: `Activity (${report.log.length + (shared?.length ?? 0)})` });
		const lines = details.createDiv({ cls: "theory-report-log-lines" });
		if (shared === null) lines.createDiv({ cls: "theory-report-meta", text: NO_ACTIVITY_LOG });
		else if (shared && shared.length > 0) lines.createEl("pre", { text: shared.join("\n") });
		if (report.log.length === 0 && shared === undefined) lines.createEl("pre", { text: "Waiting for Claude…" });
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
	 * The shared Activity log of a report from `.compiles/` (REP-54): its lines, null when there is none, or an empty
	 * list while it is read, which redraws once it is.
	 */
	private sharedLog(report: CompileReport): string[] | null {
		const file = report.shared?.file;
		if (!file) return null;
		if (this.sharedLogs.has(file)) return this.sharedLogs.get(file) ?? null;
		this.sharedLogs.set(file, []);
		let vaultPath: string;
		try {
			vaultPath = this.plugin.getVaultPath();
		} catch {
			this.sharedLogs.set(file, null);
			return null;
		}
		readActivityLog(vaultPath, file)
			.catch(() => null)
			.then((lines) => {
				this.sharedLogs.set(file, lines);
				this.refresh();
			});
		return [];
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

	/** CMP-68, CMP-81: a GitHub step failed, and the compile waits for Retry, or Discard while it is still offered. */
	private renderIssueFailure(report: CompileReport) {
		if (!report.issueFailure || report.status !== "running") return;
		const card = this.contentEl.createDiv({ cls: "theory-permission-card theory-build-question" });
		card.createDiv({ cls: "theory-permission-title", text: report.issueFailure });
		const discard = canDiscard(report.issues ?? [], report.closing);
		const left = stepsLeft(report.issues ?? [], report.closing);
		if (left.length > 0) {
			card.createDiv({ cls: "theory-report-meta", text: "Still to do on GitHub:" });
			const list = card.createEl("ul");
			for (const line of left) list.createEl("li", { text: line });
		}
		card.createDiv({
			cls: "theory-report-meta",
			text: discard
				? "Retry carries on from there. Discard closes the issues already created as not planned, and the last compile marker doesn't move."
				: "Retry carries on from there. An earlier issue has already changed on GitHub, which can't be undone, so there is no Discard.",
		});
		const buttons = card.createDiv({ cls: "theory-permission-buttons" });
		buttons.createEl("button", { cls: "mod-cta", text: "Retry" }).addEventListener("click", () => this.plugin.retryIssues());
		if (discard) buttons.createEl("button", { text: "Discard" }).addEventListener("click", () => this.plugin.discardIssues());
	}

	/**
	 * "Recompiled on {date}" with a link to the new report (REP-41), and "Recompiles the compile of {date}" with a
	 * link to the earlier one (REP-42). The links are read from the reports, never from the vault (REP-10).
	 */
	private renderRecompileLinks(report: CompileReport) {
		const line = (text: string, date: string, target: CompileReport | null) => {
			const el = this.contentEl.createEl("p", { cls: "theory-report-meta theory-report-recompile" });
			el.appendText(text);
			const when = new Date(date).toLocaleString();
			if (!target) {
				el.appendText(when);
				return;
			}
			const link = el.createEl("a", { text: when, href: "#" });
			link.setAttr("aria-label", "Open that compile's report");
			link.addEventListener("click", (event) => {
				event.preventDefault();
				this.show(target.id);
			});
		};
		if (report.recompileOf !== undefined) {
			const earlier = recompiledReport(report, this.plugin.allReports());
			const date = earlier?.startedAt ?? report.earlier?.startedAt;
			if (date) line("Recompiles the compile of ", date, earlier);
		}
		const recompile = recompiledBy(report, this.plugin.allReports());
		if (recompile) line("Recompiled on ", recompile.startedAt, recompile);
	}

	/** Counts the pending revisions again, and redraws when the count changed, so Recompile follows commits (CMP-74). */
	private countPending() {
		let vaultPath: string;
		try {
			vaultPath = this.plugin.getVaultPath();
		} catch {
			return;
		}
		pendingRevisionCount(vaultPath, this.plugin.settings.shareReports)
			.catch(() => 0)
			.then((pending) => {
				if (pending === this.pending) return;
				this.pending = pending;
				this.refresh();
			});
	}

	/** Recompile next to Build, while the compile can be recompiled (CMP-72 to CMP-74). Its checks run on click (CMP-75). */
	private addRecompile(buttons: HTMLElement, report: CompileReport) {
		const state = recompileButton(report, this.plugin.allReports(), this.pending, this.plugin.isCompiling());
		if (!state.shown) return;
		const button = buttons.createEl("button", { text: "Recompile" });
		button.disabled = state.disabled;
		if (state.tooltip) setTooltip(button, state.tooltip);
		button.addEventListener("click", () => this.plugin.recompile(report.id));
	}

	/** The build: "Build them now?", the Build button, its status and message, and what it waits on (BLD-1, BLD-17, BLD-22, BLD-23, BLD-28). */
	private renderBuild(report: CompileReport) {
		const issues = (report.issues ?? []).filter((i) => i.kind === "issue" && i.number !== undefined);
		if (report.status !== "succeeded" || issues.length === 0) return;
		// A recompiled compile offers no Build and no Recompile: the recompile's report owns its issues (REP-41, CMP-83).
		if (recompiledBy(report, this.plugin.allReports())) return;
		const build = report.build;
		const busy = this.plugin.isCompiling();
		const section = this.contentEl.createDiv({ cls: "theory-report-build" });
		if (!build) {
			const ask = section.createDiv({ cls: "theory-permission-card theory-build-question" });
			ask.createDiv({ cls: "theory-permission-title", text: buildPromptText(report) });
			const buttons = ask.createDiv({ cls: "theory-permission-buttons" });
			const now = buttons.createEl("button", { cls: "mod-cta", text: "Build" });
			now.disabled = busy;
			now.addEventListener("click", () => this.plugin.build(report.id));
			this.addRecompile(buttons, report);
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
		this.addRecompile(row, report);
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

	/**
	 * REP-40: the issues this compile created, the epic first, with their build state. A recompiled compile's issues
	 * show where they went (REP-41). A recompile's are marked new or continued, with the closed ones after (REP-42).
	 */
	private renderIssues(report: CompileReport) {
		const issues = report.issues ?? [];
		const closed = report.recompileOf !== undefined ? (report.closing ?? []).filter((c) => c.closed) : [];
		if (issues.length === 0 && closed.length === 0) return;
		const recompile = recompiledBy(report, this.plugin.allReports());
		const section = this.section("Issues", issues.length);
		for (const issue of issues) {
			const mark = recompile ? issueFate(issue, recompile) : report.recompileOf !== undefined ? issueOrigin(issue) : null;
			this.issueRow(section, issue, mark);
		}
		if (closed.length === 0) return;
		section.createDiv({ cls: "theory-report-meta", text: "Closed as not planned:" });
		for (const issue of closed) {
			const item = section.createDiv({ cls: `theory-report-issue is-${issue.kind}` });
			item.createSpan({ cls: "theory-report-pr-repo", text: `${issue.repo}#${issue.number}` });
			if (issue.url) item.createEl("a", { text: issue.title, href: issue.url });
			else item.createSpan({ text: issue.title });
			item.createSpan({ cls: "theory-pr-state is-closed", text: "closed" });
		}
	}

	private issueRow(container: HTMLElement, issue: IssueRecord, mark: "new" | "continued" | "closed" | null = null) {
		const item = container.createDiv({ cls: `theory-report-issue is-${issue.kind}` });
		item.createSpan({ cls: "theory-report-pr-repo", text: issue.number !== undefined ? `${issue.repo}#${issue.number}` : issue.repo });
		if (issue.url) item.createEl("a", { text: issue.title, href: issue.url });
		else item.createSpan({ text: `${issue.title} (not created)` });
		if (issue.kind === "epic") item.createSpan({ cls: "theory-pr-state is-epic", text: "Epic" });
		else if (issue.discarded) item.createSpan({ cls: "theory-pr-state is-closed", text: "Discarded" });
		else if (issue.build) item.createSpan({ cls: `theory-pr-state is-build-${issue.build}`, text: BUILD_STATE_TEXT[issue.build] });
		if (mark) item.createSpan({ cls: `theory-pr-state is-${mark === "closed" ? "closed" : "none"}`, text: mark });
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
