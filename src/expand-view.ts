import { App, ItemView, Modal, Notice, Setting, TFile, ViewStateResult, WorkspaceLeaf, setIcon } from "obsidian";
import { join } from "path";
import { existsSync } from "fs";
import { ExpandRun, ExpandSuggestion, createExpandNote, readExpandContext, startExpand, suggestionText } from "./expand";
import type TheoryPlugin from "./main";

export const EXPAND_VIEW_TYPE = "theory-expand";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface Card extends ExpandSuggestion {
	/** Set once Create note made the note. */
	created?: string;
}

/** What the view shows. Suggestions live only here: never in plugin data or the vault. Closing the view discards them. */
type ExpandState =
	| { kind: "idle" }
	| { kind: "running"; run: ExpandRun }
	| { kind: "shown"; cards: Card[] }
	| { kind: "failed"; reason: string };

/** The Expand view for one model folder: Claude's suggested notes, one card each. */
export class ExpandView extends ItemView {
	plugin: TheoryPlugin;
	folder = "";
	private state: ExpandState = { kind: "idle" };

	constructor(leaf: WorkspaceLeaf, plugin: TheoryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return EXPAND_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.folder ? `Expand ${this.folder}` : "Expand";
	}

	getIcon(): string {
		return "sparkles";
	}

	getState(): Record<string, unknown> {
		return { folder: this.folder };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const folder = (state as { folder?: unknown } | null)?.folder;
		if (typeof folder === "string") this.folder = folder;
		await super.setState(state, result);
		this.render();
	}

	async onOpen() {
		this.render();
	}

	async onClose() {
		if (this.state.kind === "running") this.state.run.cancel();
		this.state = { kind: "idle" };
		this.plugin.expandChanged();
	}

	isExpanding(): boolean {
		return this.state.kind === "running";
	}

	/** Asks Claude at once. Running it again replaces the suggestions. */
	async expand() {
		if (this.state.kind === "running" || !this.folder) return;
		const { claudeCommand, model, effort, projectFolder } = this.plugin.settings;
		let run: ExpandRun;
		try {
			const vaultPath = this.plugin.getVaultPath();
			const context = await readExpandContext(vaultPath, this.folder);
			const repo = projectFolder ? join(projectFolder, this.folder) : "";
			const repoPath = repo && existsSync(join(repo, ".git")) ? repo : null;
			run = startExpand({ claudeCommand, model, effort, vaultPath, repoPath, context });
		} catch (error) {
			this.state = { kind: "failed", reason: errorMessage(error) };
			this.render();
			return;
		}
		this.state = { kind: "running", run };
		this.render();
		this.plugin.expandChanged();
		try {
			const suggestions = await run.done;
			if (this.state.kind === "running" && this.state.run === run) this.state = { kind: "shown", cards: suggestions };
		} catch (error) {
			if (this.state.kind === "running" && this.state.run === run) this.state = { kind: "failed", reason: errorMessage(error) };
		}
		this.render();
		this.plugin.expandChanged();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("theory-report", "theory-expand");
		contentEl.createEl("h4", { text: `Notes ${this.folder || "this repository"} may be missing` });
		contentEl.createDiv({
			cls: "theory-report-meta",
			text: "Claude only suggests. You decide which notes exist and write every word in them.",
		});

		const state = this.state;
		if (state.kind === "idle") {
			contentEl.createDiv({
				cls: "theory-report-empty",
				text: `Click Expand on ${this.folder || "a model folder"}/index.md to ask Claude.`,
			});
			return;
		}
		if (state.kind === "running") {
			contentEl.createDiv({ cls: "theory-report-empty", text: "Expanding…" });
			return;
		}
		if (state.kind === "failed") {
			contentEl.createDiv({ cls: "theory-suggestion-error", text: `Couldn't expand: ${state.reason}` });
			return;
		}
		if (state.cards.length === 0) {
			contentEl.createDiv({ cls: "theory-report-empty", text: "No missing notes found." });
			return;
		}
		for (const card of state.cards) this.card(contentEl, state.cards, card);
	}

	/** One suggestion. Claude's text is shown as plain text only. */
	private card(container: HTMLElement, cards: Card[], card: Card) {
		const el = container.createDiv({ cls: "theory-expand-card" });
		const title = el.createDiv({ cls: "theory-expand-name" });
		setIcon(title.createSpan({ cls: "theory-report-reply-icon" }), "file-plus");
		title.createSpan({ text: card.name });
		if (card.created) title.createSpan({ cls: "theory-expand-created", text: "Created" });
		if (card.question) el.createDiv({ cls: "theory-expand-question", text: card.question });
		if (card.reason) el.createDiv({ cls: "theory-report-meta", text: card.reason });
		if (card.headings.length > 0) {
			const list = el.createEl("ul", { cls: "theory-expand-headings" });
			for (const heading of card.headings) list.createEl("li", { text: heading });
		}

		const buttons = el.createDiv({ cls: "theory-suggestion-buttons" });
		if (!card.created) {
			buttons
				.createEl("button", { cls: "mod-cta", text: "Create note" })
				.addEventListener("click", () => new NoteNameModal(this.app, card.name, (name) => this.create(card, name)).open());
			buttons.createEl("button", { text: "Copy" }).addEventListener("click", async () => {
				await navigator.clipboard.writeText(suggestionText(card));
				new Notice("Copied. Write the note in your own words.");
			});
		}
		buttons.createEl("button", { text: "Dismiss" }).addEventListener("click", () => {
			cards.splice(cards.indexOf(card), 1);
			this.render();
		});
	}

	/** Creates an empty note with the confirmed name and opens it. It never commits. Returns false to keep the box open. */
	private async create(card: Card, name: string): Promise<boolean> {
		const { vault } = this.app;
		try {
			const result = await createExpandNote(
				{ files: () => vault.getFiles().map((file) => file.path), create: (path, text) => vault.create(path, text) },
				this.folder,
				name,
			);
			if (!result.created) {
				new Notice(result.reason);
				return false;
			}
			card.created = result.path;
			this.render();
			const file = vault.getAbstractFileByPath(result.path);
			if (file instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(file);
			return true;
		} catch (error) {
			new Notice(`Couldn't create the note: ${errorMessage(error)}`, 10000);
			return false;
		}
	}
}

/** Asks for the new note's name, filled with the suggested one. The engineer confirms or retypes it. */
class NoteNameModal extends Modal {
	constructor(
		app: App,
		private suggested: string,
		private onConfirm: (name: string) => Promise<boolean>,
	) {
		super(app);
	}

	onOpen() {
		this.setTitle("Create note");
		let name = this.suggested;
		const submit = async () => {
			if (await this.onConfirm(name)) this.close();
		};
		new Setting(this.contentEl).setName("Name").addText((text) => {
			text.setValue(name).onChange((value) => (name = value));
			text.inputEl.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					submit();
				}
			});
			window.setTimeout(() => text.inputEl.select(), 0);
		});
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		buttons.createEl("button", { cls: "mod-cta", text: "Create" }).addEventListener("click", submit);
	}

	onClose() {
		this.contentEl.empty();
	}
}
