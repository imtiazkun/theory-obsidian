import { App, ItemView, Modal, Notice, Setting, TFile, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { type ExpandSuggestion, createEmptyNote, noteNameProblem, suggestionText } from "./expand";
import type TheoryPlugin from "./main";

export const EXPAND_VIEW_TYPE = "theory-expand";

/** What the view shows. Suggestions live only here: never in plugin data or the vault (EXP-19). */
type ExpandState =
	| { state: "idle" }
	| { state: "running" }
	| { state: "shown"; cards: { suggestion: ExpandSuggestion; created: boolean }[] }
	| { state: "failed"; reason: string };

/** Claude's suggestions for one repository's missing notes, as cards. */
export class ExpandView extends ItemView {
	repo = "";
	private current: ExpandState = { state: "idle" };

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: TheoryPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return EXPAND_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.repo ? `Expand ${this.repo}` : "Expand";
	}

	getIcon(): string {
		return "sparkles";
	}

	getState(): Record<string, unknown> {
		return { repo: this.repo };
	}

	async setState(state: { repo?: string }, result: ViewStateResult) {
		this.repo = typeof state?.repo === "string" ? state.repo : "";
		this.current = this.plugin.isExpanding(this.repo) ? { state: "running" } : { state: "idle" };
		await super.setState(state, result);
		this.render();
	}

	async onOpen() {
		this.render();
	}

	async onClose() {
		this.current = { state: "idle" };
		this.plugin.expandViewClosed(this.repo);
	}

	running() {
		this.current = { state: "running" };
		this.render();
	}

	/** Replaces whatever was on screen. */
	showSuggestions(suggestions: ExpandSuggestion[]) {
		this.current = { state: "shown", cards: suggestions.map((suggestion) => ({ suggestion, created: false })) };
		this.render();
	}

	showFailure(reason: string) {
		this.current = { state: "failed", reason };
		this.render();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("theory-report", "theory-expand");

		const toolbar = contentEl.createDiv({ cls: "theory-report-toolbar" });
		toolbar.createEl("h3", { text: this.getDisplayText() });
		const running = this.current.state === "running";
		const again = toolbar.createEl("button", { cls: "mod-cta", text: running ? "Expanding…" : "Expand" });
		again.disabled = running || !this.repo;
		again.addEventListener("click", () => this.plugin.expand(this.repo));

		const state = this.current;
		switch (state.state) {
			case "idle":
				return;
			case "running":
				contentEl.createDiv({ cls: "theory-report-empty", text: "Expanding…" });
				return;
			case "failed":
				contentEl.createDiv({ cls: "theory-suggestion-error", text: `Couldn't expand: ${state.reason}` });
				return;
			case "shown":
				if (state.cards.length === 0) {
					contentEl.createDiv({ cls: "theory-report-empty", text: "No missing notes found." });
					return;
				}
				contentEl.createDiv({
					cls: "theory-report-meta",
					text: "Claude only suggests. You decide which notes exist and write every word in them.",
				});
				for (const card of state.cards) this.card(contentEl, state.cards, card);
		}
	}

	private card(
		container: HTMLElement,
		cards: { suggestion: ExpandSuggestion; created: boolean }[],
		card: { suggestion: ExpandSuggestion; created: boolean },
	) {
		const { suggestion } = card;
		const el = container.createDiv({ cls: "theory-expand-card" });
		const title = el.createDiv({ cls: "theory-expand-name" });
		title.createSpan({ text: suggestion.name });
		if (card.created) title.createSpan({ cls: "theory-expand-created", text: "Created" });
		if (suggestion.question) el.createDiv({ cls: "theory-expand-question", text: suggestion.question });
		if (suggestion.why) el.createDiv({ cls: "theory-report-meta", text: `Why: ${suggestion.why}` });
		if (suggestion.headings.length > 0) {
			const list = el.createEl("ul", { cls: "theory-expand-headings" });
			for (const heading of suggestion.headings) list.createEl("li", { text: heading });
		}

		const buttons = el.createDiv({ cls: "theory-suggestion-buttons" });
		if (!card.created) {
			buttons.createEl("button", { cls: "mod-cta", text: "Create note" }).addEventListener("click", () => {
				new CreateNoteModal(this.app, suggestion.name, async (name) => {
					const path = await this.createNote(name);
					if (!path) return false;
					card.created = true;
					this.render();
					return true;
				}).open();
			});
			buttons.createEl("button", { text: "Copy" }).addEventListener("click", async () => {
				await navigator.clipboard.writeText(suggestionText(suggestion));
				new Notice("Copied. Write the note in your own words.");
			});
		}
		buttons.createEl("button", { text: "Dismiss" }).addEventListener("click", () => {
			cards.splice(cards.indexOf(card), 1);
			this.render();
		});
	}

	/** Creates the empty note and opens it. Returns its path, or null when it couldn't. Never commits. */
	private async createNote(name: string): Promise<string | null> {
		try {
			const path = await createEmptyNote(this.plugin.getVaultPath(), this.repo, name, (p) => this.app.vault.create(p, ""));
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(file);
			this.plugin.refreshGitState();
			return path;
		} catch (error) {
			new Notice(error instanceof Error ? error.message : String(error));
			return null;
		}
	}
}

/** Asks for the new note's name, filled with the suggested one. */
class CreateNoteModal extends Modal {
	private name: string;

	constructor(
		app: App,
		suggested: string,
		private onConfirm: (name: string) => Promise<boolean>,
	) {
		super(app);
		this.name = suggested;
	}

	onOpen() {
		this.setTitle("Create note");
		const { contentEl } = this;
		const setting = new Setting(contentEl).setName("Name").setDesc("The note is created empty. You write every word in it.");
		setting.addText((text) => {
			text.setValue(this.name).onChange((value) => (this.name = value));
			text.inputEl.addEventListener("keydown", (event) => {
				if (event.key === "Enter") this.confirm();
			});
			window.setTimeout(() => text.inputEl.select(), 0);
		});
		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) => button.setButtonText("Create").setCta().onClick(() => this.confirm()));
	}

	private async confirm() {
		const problem = noteNameProblem(this.name.trim());
		if (problem) {
			new Notice(problem);
			return;
		}
		if (await this.onConfirm(this.name)) this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}
