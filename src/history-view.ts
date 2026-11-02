import { ItemView, TFile, WorkspaceLeaf, debounce } from "obsidian";
import type TheoryPlugin from "./main";
import { fileHistory, hasUncommittedChanges } from "./vault";

export const HISTORY_VIEW_TYPE = "theory-commit-history";

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	["year", 365 * 24 * 3600],
	["month", 30 * 24 * 3600],
	["week", 7 * 24 * 3600],
	["day", 24 * 3600],
	["hour", 3600],
	["minute", 60],
];
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function timeAgo(date: Date): string {
	const seconds = (date.getTime() - Date.now()) / 1000;
	for (const [unit, size] of UNITS) {
		if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
	}
	return "just now";
}

export class CommitHistoryView extends ItemView {
	plugin: TheoryPlugin;
	// Ignores results from an older refresh that finishes after a newer one.
	private refreshId = 0;

	constructor(leaf: WorkspaceLeaf, plugin: TheoryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return HISTORY_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Commit history";
	}

	getIcon(): string {
		return "history";
	}

	async onOpen() {
		this.addAction("refresh-cw", "Refresh", () => this.refresh());

		const refreshSoon = debounce(() => this.refresh(), 1000, true);
		this.registerEvent(this.app.workspace.on("file-open", () => this.refresh()));
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file === this.app.workspace.getActiveFile()) refreshSoon();
			}),
		);
		this.registerEvent(this.app.vault.on("rename", () => this.refresh()));

		await this.refresh();
	}

	async refresh() {
		const id = ++this.refreshId;
		const file = this.app.workspace.getActiveFile();
		const { contentEl } = this;

		if (!this.plugin.isVaultSetUp()) {
			this.renderVaultNotSetUp();
			return;
		}
		if (!file) {
			this.renderMessage("Open a note to see its commit history.");
			return;
		}

		let commits;
		let dirty;
		try {
			const basePath = this.plugin.getVaultPath();
			[commits, dirty] = await Promise.all([
				fileHistory(basePath, file.path),
				hasUncommittedChanges(basePath, file.path),
			]);
		} catch (error) {
			if (id !== this.refreshId) return;
			const message = error instanceof Error ? error.message : String(error);
			this.renderMessage(`Couldn't read history: ${message}`);
			return;
		}
		if (id !== this.refreshId) return;

		contentEl.empty();
		contentEl.addClass("theory-history");
		this.renderHeader(file, dirty);

		if (commits.length === 0) {
			contentEl.createDiv({ cls: "theory-history-empty", text: "No commits yet for this note." });
			return;
		}

		const list = contentEl.createDiv({ cls: "theory-history-list" });
		for (const commit of commits) {
			const item = list.createDiv({ cls: "theory-history-item" });
			item.setAttr("title", `${commit.hash}\n${commit.author} <${commit.email}>\n${commit.date.toLocaleString()}`);
			item.createDiv({ cls: "theory-history-subject", text: commit.subject });
			const meta = item.createDiv({ cls: "theory-history-meta" });
			meta.createSpan({ text: commit.author });
			meta.createSpan({ text: " · " });
			meta.createSpan({ text: timeAgo(commit.date) });
			meta.createSpan({ text: " · " });
			meta.createSpan({ cls: "theory-history-hash", text: commit.hash.slice(0, 7) });
		}
	}

	private renderHeader(file: TFile, dirty: boolean) {
		const header = this.contentEl.createDiv({ cls: "theory-history-header" });
		header.createDiv({ cls: "theory-history-title", text: file.basename });
		if (dirty) {
			const status = header.createDiv({ cls: "theory-history-dirty" });
			status.createSpan({ text: "Uncommitted changes" });
			status
				.createEl("button", { cls: "mod-cta theory-history-commit", text: "Commit…" })
				.addEventListener("click", () => this.plugin.openCommitModal(file));
		}
	}

	private renderMessage(text: string) {
		this.contentEl.empty();
		this.contentEl.addClass("theory-history");
		this.contentEl.createDiv({ cls: "theory-history-empty", text });
	}

	private renderVaultNotSetUp() {
		this.renderMessage("This vault isn't a git repository yet.");
		const button = this.contentEl.createEl("button", { cls: "mod-cta", text: "Setup vault" });
		button.addEventListener("click", async () => {
			button.disabled = true;
			await this.plugin.setUpVault();
			await this.refresh();
		});
	}
}
