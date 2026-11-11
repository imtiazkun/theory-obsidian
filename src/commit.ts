import { MarkdownView, getIconIds } from "obsidian";
import type TheoryPlugin from "./main";
import { hasUncommittedChanges } from "./vault";

export function commitIcon(): string {
	// Newer Lucide versions renamed "git-commit" to "git-commit-horizontal".
	return getIconIds().includes("lucide-git-commit-horizontal") ? "git-commit-horizontal" : "git-commit";
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
				button = view.addAction(commitIcon(), "Commit changes", () => this.plugin.openCommitPage(view.file));
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
