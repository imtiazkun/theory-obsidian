import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { basename } from "path";
import type { PullRequestState } from "./github";
import { timeAgo } from "./history-view";
import type TheoryPlugin from "./main";
import { ONLY_HERE } from "./report-list";
import { PR_STATE_TEXT, STATUS_ICON, STATUS_TEXT } from "./report-view";

export const COMPILE_HISTORY_VIEW_TYPE = "theory-compile-history";

const count = new Intl.NumberFormat();

/**
 * Past compiles, newest first, beside the commit history in the right sidebar: the reports in plugin data and the
 * shared reports in `.compiles/` together (REP-51).
 */
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
		// Teammates' compiles may have arrived since `.compiles/` was last read (REP-51).
		await this.plugin.loadSharedReports();
	}

	refresh() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("theory-history");

		const entries = this.plugin.reportEntries().filter((e) => e.kind === "report");
		if (entries.length === 0) {
			contentEl.createDiv({ cls: "theory-history-empty", text: "No compiles yet." });
			return;
		}

		const list = contentEl.createDiv({ cls: "theory-history-list" });
		for (const entry of entries) {
			if (entry.kind !== "report") continue;
			const { report } = entry;
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
			// REP-51: who compiled it, and whether it is only on this machine.
			meta.createSpan({ text: report.author || "Unknown author" });
			if (entry.onlyHere) {
				meta.createSpan({ text: " · " });
				meta.createSpan({ cls: "theory-history-only-here", text: ONLY_HERE });
			}
			// An ACP agent reports how full its context is, not the tokens used, so there is no count (AGT-20).
			if (report.agent !== "acp") {
				meta.createSpan({ text: " · " });
				meta.createSpan({
					text: report.tokens === undefined ? "tokens unknown" : `${count.format(report.tokens)} tokens`,
				});
			}

			// The state of its pull requests, one per repository when there are several.
			const prs = report.pullRequests ?? [];
			const repos = new Map<string, PullRequestState | null>();
			for (const issue of report.issues ?? []) if (issue.kind === "issue" && issue.number !== undefined) repos.set(issue.repoPath, null);
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
