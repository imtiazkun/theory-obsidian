import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { basename } from "path";
import type { PullRequestState } from "./github";
import { timeAgo } from "./history-view";
import type TheoryPlugin from "./main";
import { PR_STATE_TEXT, STATUS_ICON, STATUS_TEXT } from "./report-view";

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
		this.addAction("refresh-cw", "Refresh pull request states", () => this.plugin.refreshPullRequestStates("action"));
		this.refresh();
		this.plugin.refreshPullRequestStates("history");
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

			// The state of its pull requests, one per repository when there are several.
			const prs = report.pullRequests ?? [];
			const repos = new Map<string, PullRequestState | null>();
			for (const b of report.branches ?? []) if (b.kept && b.commits.length > 0) repos.set(b.repoPath, null);
			for (const pr of prs) repos.set(pr.repoPath, pr.state);
			const states = item.createDiv({ cls: "theory-history-meta theory-compile-history-prs" });
			const state = (value: PullRequestState | null) =>
				states.createSpan({ cls: `theory-pr-state is-${value ?? "none"}`, text: value ? PR_STATE_TEXT[value] : "None" });
			if (repos.size <= 1) {
				states.appendText("Pull request: ");
				state([...repos.values()][0] ?? null);
			} else {
				[...repos].forEach(([path, value], i) => {
					if (i > 0) states.appendText(" · ");
					states.appendText(`${basename(path)}: `);
					state(value);
				});
			}
		}
	}
}
