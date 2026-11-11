import { Extension, Range, StateEffect } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, PluginValue, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { MarkdownView, editorInfoField } from "obsidian";
import type TheoryPlugin from "./main";
import { RuleAuthor, noteRuleAuthors } from "./rule-authors";

/** Asks every open editor to work out its rule authors again. */
const refreshAuthors = StateEffect.define<null>();

/** How long after the last keystroke the authors are worked out again (HDR-19). */
const TYPING_PAUSE_MS = 1500;

class AuthorWidget extends WidgetType {
	constructor(private author: RuleAuthor) {
		super();
	}

	eq(other: AuthorWidget): boolean {
		return other.author.label === this.author.label && other.author.tooltip === this.author.tooltip;
	}

	toDOM(): HTMLElement {
		// Plain text and attributes only: the label comes from git, and is never part of the note (HDR-20).
		const span = document.createElement("span");
		span.className = "theory-rule-author";
		span.textContent = this.author.label;
		if (this.author.tooltip) span.setAttribute("aria-label", this.author.tooltip);
		return span;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

/**
 * Shows who last changed each rule, in grey after its first line (HDR-14). Display only: the text is
 * a widget, never written into the note, and worked out from git each time (HDR-19, HDR-20).
 */
export class RuleAuthorsOverlay {
	constructor(private plugin: TheoryPlugin) {}

	editorExtension(): Extension {
		const overlay = this;
		return ViewPlugin.fromClass(
			class implements PluginValue {
				decorations: DecorationSet = Decoration.none;
				private timer: number | null = null;
				/** Bumped on every change, so an older answer from git never replaces a newer one. */
				private version = 0;

				constructor(private view: EditorView) {
					this.load();
				}

				update(update: ViewUpdate) {
					if (update.docChanged) {
						// The labels follow their lines until git answers again.
						this.decorations = this.decorations.map(update.changes);
						this.version++;
						this.schedule();
					}
					if (update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshAuthors)))) this.load();
				}

				private schedule() {
					if (this.timer !== null) window.clearTimeout(this.timer);
					this.timer = window.setTimeout(() => {
						this.timer = null;
						this.load();
					}, TYPING_PAUSE_MS);
				}

				private async load() {
					const version = ++this.version;
					const decorations = await overlay.decorations(this.view);
					if (version !== this.version) return;
					this.decorations = decorations;
					// An empty transaction makes CodeMirror read the decorations again.
					this.view.dispatch({});
				}

				destroy() {
					if (this.timer !== null) window.clearTimeout(this.timer);
					this.version++;
				}
			},
			{ decorations: (value) => value.decorations },
		);
	}

	private async decorations(view: EditorView): Promise<DecorationSet> {
		const file = view.state.field(editorInfoField, false)?.file;
		if (!this.plugin.settings.showRuleAuthors || !file || file.extension !== "md" || !this.plugin.isVaultSetUp()) {
			return Decoration.none;
		}
		const text = view.state.doc.toString();
		let authors: RuleAuthor[];
		try {
			authors = await noteRuleAuthors(this.plugin.getVaultPath(), file.path, text);
		} catch {
			return Decoration.none;
		}
		const doc = view.state.doc;
		const ranges: Range<Decoration>[] = [];
		for (const author of authors) {
			if (author.line + 1 > doc.lines) continue;
			const line = doc.line(author.line + 1);
			ranges.push(Decoration.widget({ widget: new AuthorWidget(author), side: 1 }).range(line.to));
		}
		return Decoration.set(ranges, true);
	}

	/** Works out every open note's rule authors again: after a commit, a pull, or the setting changing (HDR-19, CFG-38). */
	sync() {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			// The editor's CodeMirror view isn't in Obsidian's public types.
			(view.editor as unknown as { cm?: EditorView }).cm?.dispatch({ effects: refreshAuthors.of(null) });
		}
	}
}
