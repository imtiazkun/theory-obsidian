import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type { Anchor } from "./anchor";
import { timeLeft, type CompileReport, type CompileStatus, type PermissionAnswer, type PermissionRequest } from "./compile";
import type TheoryPlugin from "./main";

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

function shortHash(hash: string | null): string {
	return hash ? hash.slice(0, 7) : "start";
}

/** Shows compile reports. They live in plugin data, never in the model. */
export class CompileReportView extends ItemView {
	plugin: TheoryPlugin;
	// The report on screen; null follows the newest one.
	private selectedId: string | null = null;
	private activityOpen = false;
	// Deny buttons on the permission cards on screen, with the time each request is denied by itself.
	private countdowns: { el: HTMLElement; expiresAt: number }[] = [];

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
		if (report.status === "running") {
			header
				.createEl("button", { cls: "theory-report-cancel", text: "Cancel" })
				.addEventListener("click", () => this.plugin.cancelCompile());
		} else if (this.plugin.overlay.report() === report) {
			header
				.createEl("button", { cls: "theory-report-cancel", text: "Clear highlights" })
				.addEventListener("click", () => this.plugin.overlay.dismiss());
		}

		if (report.summary) contentEl.createEl("p", { cls: "theory-report-summary", text: report.summary });

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
			for (const q of report.questions) {
				const item = section.createDiv({ cls: "theory-report-question" });
				const row = item.createDiv({ cls: "theory-report-question-row" });
				row.createDiv({ text: q.question });
				// Reply opens the note at the rule that needs updating, else its heading, else the top. Engineers answer in the model.
				const target: Anchor | undefined = q.anchors?.[0] ?? (q.notes[0] ? { path: q.notes[0] } : undefined);
				if (target) {
					const reply = row.createEl("button", { cls: "theory-report-reply", text: "Reply" });
					setIcon(reply.createSpan({ cls: "theory-report-reply-icon" }), "reply");
					reply.setAttr("aria-label", `Open ${target.path} at the rule this question is about`);
					reply.addEventListener("click", () => this.plugin.overlay.jump(target));
				}
				if (q.notes.length === 0) continue;
				const notes = item.createDiv({ cls: "theory-report-notes" });
				for (const note of q.notes) {
					const link = notes.createEl("a", { cls: "internal-link", text: note, href: note });
					link.addEventListener("click", (event) => {
						event.preventDefault();
						this.app.workspace.openLinkText(note, "", false);
					});
				}
			}
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

		if (report.log.length === 0 && report.status !== "running") return;
		// Waiting permission requests show as cards on their own line of the log.
		const waiting = report.status === "running" ? this.plugin.permissionRequests() : [];
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

	/** A card for one waiting permission request, answered on its own. */
	private permissionCard(container: HTMLElement, request: PermissionRequest): HTMLElement {
		const card = container.createDiv({ cls: "theory-permission-card" });
		const title = card.createDiv({ cls: "theory-permission-title" });
		setIcon(title.createSpan({ cls: "theory-permission-icon" }), "shield-question");
		title.createSpan({ text: request.tool });
		card.createEl("pre", { cls: "theory-permission-target", text: request.target });
		card.createDiv({ cls: "theory-report-meta", text: request.reason });
		const buttons = card.createDiv({ cls: "theory-permission-buttons" });
		const choices: [PermissionAnswer, string][] = [
			["allow", "Allow"],
			["always", "Always allow"],
			["deny", "Deny"],
		];
		for (const [answer, text] of choices) {
			const button = buttons.createEl("button", { text, cls: answer === "allow" ? "mod-cta" : "" });
			if (answer === "always") button.setAttr("title", `Also adds ${request.rule} to Allowed commands`);
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
