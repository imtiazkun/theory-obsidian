import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { timeAgo } from "./history-view";
import type TheoryPlugin from "./main";
import { STATUS_ICON, STATUS_TEXT } from "./report-view";

export const COMPILE_HISTORY_VIEW_TYPE = "theory-compile-history";

const count = new Intl.NumberFormat();

/** Past compiles, newest first, beside the commit history in the right sidebar. Read from the reports in plugin data. */
export class CompileHistoryView extends ItemView {
	plugin: TheoryPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: TheoryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return COMPILE_HISTORY_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Compile history";
	}

	getIcon(): string {
		return "hammer";
	}

	async onOpen() {
		this.refresh();
	}

	refresh() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("theory-history");

		const reports = this.plugin.reports;
		if (reports.length === 0) {
			contentEl.createDiv({ cls: "theory-history-empty", text: "No compiles yet." });
			return;
		}

		const list = contentEl.createDiv({ cls: "theory-history-list" });
		for (const report of reports) {
			const started = new Date(report.startedAt);
			const item = list.createDiv({ cls: `theory-history-item theory-compile-history-item is-${report.status}` });
			item.setAttr("title", `${started.toLocaleString()}\nClick to open the report.`);
			item.addEventListener("click", () => this.plugin.showReport(report.id));

			const subject = item.createDiv({ cls: "theory-history-subject theory-compile-history-status" });
			setIcon(subject.createSpan({ cls: "theory-compile-history-icon" }), STATUS_ICON[report.status]);
			subject.createSpan({ text: STATUS_TEXT[report.status] });

			const meta = item.createDiv({ cls: "theory-history-meta" });
			meta.createSpan({ text: timeAgo(started) });
			meta.createSpan({ text: " · " });
			meta.createSpan({ text: report.author || "Unknown author" });
			meta.createSpan({ text: " · " });
			meta.createSpan({
				text: report.tokens === undefined ? "tokens unknown" : `${count.format(report.tokens)} tokens`,
			});
		}
	}
}
