import { App, MarkdownView, Modal, Setting, TFile, getIconIds, setIcon } from "obsidian";
import type TheoryPlugin from "./main";
import { hasUncommittedChanges } from "./vault";

export function commitIcon(): string {
	// Newer Lucide versions renamed "git-commit" to "git-commit-horizontal".
	return getIconIds().includes("lucide-git-commit-horizontal") ? "git-commit-horizontal" : "git-commit";
}

export class CommitModal extends Modal {
	private includeAll = false;

	constructor(
		app: App,
		private plugin: TheoryPlugin,
		/** The note to commit, or null to commit every changed file. */
		private file: TFile | null,
		private otherChanges: string[],
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		this.setTitle("Commit changes");
		contentEl.addClass("theory-commit");

		const { file } = this;
		const count = this.otherChanges.length;
		const chip = contentEl.createDiv({ cls: "theory-commit-file" });
		setIcon(chip.createSpan({ cls: "theory-commit-file-icon" }), file ? "file-text" : "files");
		chip.createSpan({ text: file ? file.path : `${count} changed ${count === 1 ? "file" : "files"}` });
		if (!file) chip.setAttr("title", this.otherChanges.join("\n"));

		const message = contentEl.createEl("textarea", {
			cls: "theory-commit-message",
			attr: { rows: "3", placeholder: "Describe what changed", "aria-label": "Commit message" },
		});
		message.value = file ? `Update ${file.basename}` : "Update model";

		if (file && count > 0) {
			new Setting(contentEl)
				.setName("Include all changed files")
				.setDesc(`${count} other ${count === 1 ? "file has" : "files have"} uncommitted changes.`)
				.addToggle((toggle) =>
					toggle.setValue(this.includeAll).onChange((value) => (this.includeAll = value)),
				);
		}

		const footer = contentEl.createDiv({ cls: "theory-commit-footer" });
		const { fullName, email } = this.plugin.settings;
		footer.createDiv({
			cls: "theory-commit-author",
			text: fullName ? `Signed as ${fullName}${email ? ` <${email}>` : ""}` : "Signed with your git identity",
		});

		const buttons = footer.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		const submit = buttons.createEl("button", {
			cls: "mod-cta",
			text: "Commit",
			attr: { "aria-label": "Commit (⌘/Ctrl + Enter)" },
		});

		const updateSubmit = () => (submit.disabled = message.value.trim() === "");
		message.addEventListener("input", updateSubmit);
		message.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				submit.click();
			}
		});

		submit.addEventListener("click", async () => {
			if (submit.disabled) return;
			submit.disabled = true;
			submit.setText("Committing…");
			const done = await this.plugin.commitChanges(
				message.value.trim(),
				this.includeAll || !file ? "all" : [file.path],
			);
			if (done) {
				this.close();
			} else {
				submit.setText("Commit");
				updateSubmit();
			}
		});

		updateSubmit();
		message.focus();
		message.select();
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Keeps a commit button in the header of every open note, marked when the note has changes. */
export class CommitButtons {
	private buttons = new Map<MarkdownView, HTMLElement>();
	// Ignores results from an older sync that finishes after a newer one.
	private syncId = 0;

	constructor(private plugin: TheoryPlugin) {}

	async sync() {
		const id = ++this.syncId;
		const setUp = this.plugin.isVaultSetUp();
		const basePath = setUp ? this.plugin.getVaultPath() : "";

		for (const [view, button] of this.buttons) {
			if (!button.isConnected) this.buttons.delete(view);
		}

		for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;

			let button = this.buttons.get(view);
			if (!button) {
				button = view.addAction(commitIcon(), "Commit changes", () => this.plugin.openCommitModal(view.file));
				button.addClass("theory-commit-button");
				this.buttons.set(view, button);
			}

			button.toggle(setUp && view.file !== null);
			if (!setUp || !view.file) continue;

			const file = view.file;
			const dirty = await hasUncommittedChanges(basePath, file.path).catch(() => false);
			if (id !== this.syncId) return;
			if (view.file !== file) continue;
			button.toggleClass("is-dirty", dirty);
			button.setAttr("aria-label", dirty ? "Commit changes" : "No changes to commit");
		}
	}

	removeAll() {
		for (const button of this.buttons.values()) button.remove();
		this.buttons.clear();
	}
}
