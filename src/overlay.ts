import { Extension, Range, StateEffect } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, PluginValue, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { MarkdownView, Notice, TFile, editorInfoField, setIcon } from "obsidian";
import { Anchor, findAnchor } from "./anchor";
import type { CompileReport } from "./compile";
import type MechoPlugin from "./main";

const refreshMarks = StateEffect.define<null>();

interface NoteMark {
	problem: string;
	anchor: Anchor;
}

/**
 * Shows where a failed compile points in the model: highlights in the editor and a banner on
 * each note. It only changes what Obsidian shows, never the notes, and Claude's text is only
 * ever set as plain text.
 */
export class FailureOverlay {
	private banners = new Map<MarkdownView, HTMLElement>();

	constructor(private plugin: MechoPlugin) {}

	/** The failed compile shown in the notes: the newest finished one, unless it was dismissed. */
	report(): CompileReport | null {
		const latest = this.plugin.reports.find((r) => r.status !== "running");
		return latest?.status === "failed" && !latest.dismissed ? latest : null;
	}

	private marks(path: string): NoteMark[] {
		const report = this.report();
		if (!report) return [];
		return report.problems.flatMap((p) =>
			p.anchors.filter((anchor) => anchor.path === path).map((anchor) => ({ problem: p.text, anchor })),
		);
	}

	/** True when the failed compile named no spot at all, and this note changed in it. */
	private isSuspect(path: string): boolean {
		const report = this.report();
		if (!report || report.problems.some((p) => p.anchors.length > 0)) return false;
		return report.suspectNotes?.includes(path) ?? false;
	}

	/** Highlights each anchored spot in the editor, with the problem as its tooltip. */
	editorExtension(): Extension {
		const overlay = this;
		return ViewPlugin.fromClass(
			class implements PluginValue {
				decorations: DecorationSet;

				constructor(view: EditorView) {
					this.decorations = overlay.decorations(view);
				}

				update(update: ViewUpdate) {
					const refreshed = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshMarks)));
					if (update.docChanged || refreshed) this.decorations = overlay.decorations(update.view);
				}
			},
			{ decorations: (value) => value.decorations },
		);
	}

	private decorations(view: EditorView): DecorationSet {
		const file = view.state.field(editorInfoField, false)?.file;
		const marks = file ? this.marks(file.path) : [];
		if (marks.length === 0) return Decoration.none;

		const doc = view.state.doc;
		const text = doc.toString();
		const ranges: Range<Decoration>[] = [];
		const lineStarts = new Set<number>();
		for (const { problem, anchor } of marks) {
			const found = findAnchor(text, anchor);
			if (!found) continue;
			// A plain attribute, so Claude's text can't add markup.
			const mark = Decoration.mark({ class: "mecho-fail-mark", attributes: { title: problem } });
			if (found.to > found.from) ranges.push(mark.range(found.from, found.to));
			for (let n = doc.lineAt(found.from).number; n <= doc.lineAt(found.to).number; n++) {
				lineStarts.add(doc.line(n).from);
			}
		}
		for (const from of lineStarts) ranges.push(Decoration.line({ class: "mecho-fail-line" }).range(from));
		return Decoration.set(ranges, true);
	}

	/** Redraws the highlights and banners, e.g. after a compile, an edit or a dismiss. */
	sync() {
		for (const [view, banner] of this.banners) {
			if (!banner.isConnected) this.banners.delete(view);
		}
		for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			// The editor's CodeMirror view isn't in Obsidian's public types.
			(view.editor as unknown as { cm?: EditorView }).cm?.dispatch({ effects: refreshMarks.of(null) });

			const file = view.file;
			const marks = file ? this.marks(file.path) : [];
			if (!file || (marks.length === 0 && !this.isSuspect(file.path))) {
				this.banners.get(view)?.remove();
				this.banners.delete(view);
				continue;
			}
			this.renderBanner(view, marks);
		}
	}

	private renderBanner(view: MarkdownView, marks: NoteMark[]) {
		let banner = this.banners.get(view);
		if (!banner?.isConnected) {
			banner = createDiv({ cls: "mecho-fail-banner" });
			view.containerEl.insertBefore(banner, view.contentEl);
			this.banners.set(view, banner);
		}
		banner.empty();

		const head = banner.createDiv({ cls: "mecho-fail-banner-head" });
		setIcon(head.createSpan({ cls: "mecho-fail-banner-icon" }), "alert-triangle");
		head.createSpan({
			cls: "mecho-fail-banner-title",
			text:
				marks.length > 0
					? `The last compile failed here (${marks.length})`
					: "The last compile failed. This note changed in it, so it may be the cause.",
		});
		const actions = head.createDiv({ cls: "mecho-fail-banner-actions" });
		actions.createEl("button", { text: "Report" }).addEventListener("click", () => this.plugin.showReportView());
		actions.createEl("button", { text: "Dismiss" }).addEventListener("click", () => this.dismiss());
		if (marks.length === 0) return;

		const text = view.getViewData();
		const list = banner.createEl("ul", { cls: "mecho-fail-banner-list" });
		for (const { problem, anchor } of marks) {
			const item = list.createEl("li");
			if (!anchor.quote && !anchor.heading) {
				item.setText(problem);
				continue;
			}
			const link = item.createEl("a", { text: problem, href: "#" });
			link.addEventListener("click", (event) => {
				event.preventDefault();
				this.jump(anchor);
			});
			if (!findAnchor(text, anchor)) {
				item.createDiv({ cls: "mecho-fail-banner-moved", text: "This spot has changed since the compile." });
			}
		}
	}

	/** Clears the failed compile's highlights. The report itself stays. */
	async dismiss() {
		const report = this.report();
		if (!report) return;
		report.dismissed = true;
		await this.plugin.saveSettings();
		this.sync();
		this.plugin.refreshReportViews();
	}

	/** Opens the note an anchor points to and selects the spot, when it can still be found. */
	async jump(anchor: Anchor) {
		const { vault, workspace } = this.plugin.app;
		const file = vault.getAbstractFileByPath(anchor.path);
		if (!(file instanceof TFile)) {
			new Notice(`${anchor.path} isn't in the vault any more.`);
			return;
		}
		const existing = workspace
			.getLeavesOfType("markdown")
			.find((leaf) => leaf.view instanceof MarkdownView && leaf.view.file === file);
		const leaf = existing ?? workspace.getLeaf(false);
		if (existing) workspace.setActiveLeaf(existing, { focus: true });
		else await leaf.openFile(file);

		const view = leaf.view;
		if (!(view instanceof MarkdownView) || (!anchor.quote && !anchor.heading)) return;
		const found = findAnchor(view.getViewData(), anchor);
		if (!found) {
			new Notice("Couldn't find this spot. The note has changed since the compile.");
			return;
		}
		const { editor } = view;
		const from = editor.offsetToPos(found.from);
		const to = editor.offsetToPos(found.to);
		if (view.getMode() === "source") {
			editor.setSelection(from, to);
			editor.scrollIntoView({ from, to }, true);
			editor.focus();
		} else {
			view.setEphemeralState({ line: from.line });
		}
	}

	removeAll() {
		for (const banner of this.banners.values()) banner.remove();
		this.banners.clear();
	}
}
