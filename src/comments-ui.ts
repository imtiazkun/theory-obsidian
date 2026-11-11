import { Extension, Range, StateEffect } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, PluginValue, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { MarkdownPostProcessorContext, MarkdownView, Notice, TFile, editorInfoField, setIcon } from "obsidian";
import { projectRepos } from "./branches";
import {
	type CommentAction,
	type CommentAnchor,
	type ReadComments,
	commentAnchor,
	commentFilePath,
	deleteComments,
	frontMatterEnd,
	moveComments,
	quotePosition,
	readCommentFile,
	saveComment,
} from "./comments";
import type TheoryPlugin from "./main";
import { IdentityError, requireIdentity } from "./vault";

const refreshUnderlines = StateEffect.define<null>();

/** What a comment would be on: the note, the anchor, and where to show the popover. */
interface Selected {
	file: TFile;
	anchor: CommentAnchor;
	rect: DOMRect | null;
}

/** An open thread's quote, to underline in the note (CMNT-24). */
interface Underline {
	threadId: string;
	quote: string;
}

/**
 * Comments on notes: the button over a selection, the popover, the underlines, and saving, committing,
 * moving and deleting comment files. Comments never change the note they are on (CMNT-2), and are never
 * sent to an agent (CMNT-1): they live in `.comments/` dot folders.
 */
export class Comments {
	private button: HTMLElement | null = null;
	private popover: HTMLElement | null = null;
	private selected: Selected | null = null;
	private underlines = new Map<string, Underline[]>();
	// Git runs one commit at a time, so comment commits wait for each other.
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private plugin: TheoryPlugin) {}

	private modelFolders(): string[] {
		return projectRepos(this.plugin.settings.projectFolder).map((repo) => repo.name);
	}

	private vaultPath(): string {
		return this.plugin.getVaultPath();
	}

	/** The note's comments, read from its comment file. */
	async read(notePath: string): Promise<ReadComments & { path: string }> {
		const path = commentFilePath(notePath, this.modelFolders());
		return { ...(await readCommentFile(this.vaultPath(), path)), path };
	}

	/** Runs `task` after every comment commit before it. */
	private serial<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queue.then(task, task);
		this.queue = next.catch(() => {});
		return next;
	}

	/** Saves a comment, reply, resolve or reopen and commits it. Returns true when it was saved. */
	async act(notePath: string, action: CommentAction): Promise<boolean> {
		let author;
		try {
			// Signed with the name and email git uses; without them nothing is saved (CMNT-8).
			author = await requireIdentity(this.vaultPath());
		} catch (error) {
			new Notice(error instanceof IdentityError ? error.message : String(error), 10000);
			return false;
		}
		try {
			const result = await this.serial(() => saveComment(this.vaultPath(), notePath, this.modelFolders(), action, author));
			if (result.notCommitted) new Notice(`Comment saved but not committed: ${result.notCommitted}`, 10000);
			// Comments that commit themselves push like any commit (CMT-31).
			else void this.plugin.push();
		} catch (error) {
			new Notice(error instanceof Error ? error.message : String(error), 10000);
			return false;
		}
		await this.refresh();
		this.plugin.refreshGitState();
		return true;
	}

	/** Moves a renamed or moved note's comments with it (CMNT-15). */
	renamed(file: TFile, oldPath: string) {
		if (file.extension !== "md" || !oldPath.toLowerCase().endsWith(".md")) return;
		this.serial(() => moveComments(this.vaultPath(), oldPath, file.path, this.modelFolders()))
			.then(async (moved) => {
				if (moved) {
					void this.plugin.push();
					await this.refresh();
				}
			})
			.catch((error) => new Notice(`Couldn't move the comments: ${error instanceof Error ? error.message : String(error)}`, 10000));
	}

	/** Deletes a deleted note's comments (CMNT-15). */
	deleted(file: TFile) {
		if (file.extension !== "md") return;
		this.serial(() => deleteComments(this.vaultPath(), file.path, this.modelFolders()))
			.then(async (deleted) => {
				if (deleted) {
					void this.plugin.push();
					await this.refresh();
				}
			})
			.catch((error) => new Notice(`Couldn't delete the comments: ${error instanceof Error ? error.message : String(error)}`, 10000));
	}

	/** Reads the open threads of every open note again and redraws the underlines and the Comments view, e.g. after a pull (CMNT-23). */
	async refresh() {
		const paths = new Set<string>();
		for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
			if (leaf.view instanceof MarkdownView && leaf.view.file) paths.add(leaf.view.file.path);
		}
		const underlines = new Map<string, Underline[]>();
		for (const path of paths) {
			const read = await this.read(path).catch(() => null);
			if (read?.kind !== "ok") continue;
			underlines.set(
				path,
				read.file.threads.filter((t) => t.resolved === null).map((t) => ({ threadId: t.id, quote: t.anchor.quote })),
			);
		}
		this.underlines = underlines;
		for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			(view.editor as unknown as { cm?: EditorView }).cm?.dispatch({ effects: refreshUnderlines.of(null) });
			if (view.getMode() === "preview") view.previewMode.rerender(true);
		}
		this.plugin.refreshCommentsViews();
	}

	/** Underlines the quote of each open thread in the editor; a click opens its thread (CMNT-24). Display only (CMNT-25). */
	editorExtension(): Extension {
		const comments = this;
		const underlines = ViewPlugin.fromClass(
			class implements PluginValue {
				decorations: DecorationSet;

				constructor(view: EditorView) {
					this.decorations = comments.decorations(view);
				}

				update(update: ViewUpdate) {
					const refreshed = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshUnderlines)));
					if (update.docChanged || refreshed) this.decorations = comments.decorations(update.view);
				}
			},
			{ decorations: (value) => value.decorations },
		);
		const clicks = EditorView.domEventHandlers({
			click: (event) => {
				const mark = (event.target as HTMLElement | null)?.closest?.(".theory-comment-mark");
				const threadId = mark?.getAttribute("data-thread");
				if (!threadId) return false;
				this.plugin.showComments(threadId);
				return false;
			},
		});
		return [underlines, clicks];
	}

	private decorations(view: EditorView): DecorationSet {
		const file = view.state.field(editorInfoField, false)?.file;
		const marks = file ? (this.underlines.get(file.path) ?? []) : [];
		if (marks.length === 0) return Decoration.none;
		const text = view.state.doc.toString();
		const ranges: Range<Decoration>[] = [];
		for (const { threadId, quote } of marks) {
			const found = quotePosition(text, quote);
			if (!found || found.to <= found.from) continue;
			ranges.push(Decoration.mark({ class: "theory-comment-mark", attributes: { "data-thread": threadId } }).range(found.from, found.to));
		}
		return Decoration.set(ranges, true);
	}

	/** Underlines open threads' quotes in Reading view, where the quote sits inside one run of text. */
	postProcessor() {
		return (el: HTMLElement, context: MarkdownPostProcessorContext) => {
			const marks = this.underlines.get(context.sourcePath) ?? [];
			if (marks.length === 0) return;
			const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
			const nodes: Text[] = [];
			while (walker.nextNode()) nodes.push(walker.currentNode as Text);
			for (const node of nodes) {
				for (const { threadId, quote } of marks) {
					const text = node.nodeValue ?? "";
					const index = quote.trim() ? text.indexOf(quote.trim()) : -1;
					if (index === -1) continue;
					const match = node.splitText(index);
					match.splitText(quote.trim().length);
					const span = createSpan({ cls: "theory-comment-mark", attr: { "data-thread": threadId } });
					match.replaceWith(span);
					span.appendChild(match);
					span.addEventListener("click", () => this.plugin.showComments(threadId));
					break;
				}
			}
		};
	}

	/** The selection in a note that a comment could be on, or null when there is none or it can't be commented (CMNT-4). */
	private selection(): Selected | null {
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !selection.toString().trim()) return null;
		const range = selection.getRangeAt(0);
		const element = (node: Node | null) => (node instanceof HTMLElement ? node : (node?.parentElement ?? null));
		const start = element(range.startContainer);
		const end = element(range.endContainer);
		if (!start || !end) return null;
		// Not in the properties block, and not across two notes.
		if (start.closest(".metadata-container, .frontmatter") || end.closest(".metadata-container, .frontmatter")) return null;
		const leaf = this.plugin.app.workspace
			.getLeavesOfType("markdown")
			.find((l) => l.view instanceof MarkdownView && l.view.contentEl.contains(start) && l.view.contentEl.contains(end));
		const view = leaf?.view;
		if (!(view instanceof MarkdownView) || !view.file) return null;
		if (!start.closest(".cm-content, .markdown-preview-view") || !end.closest(".cm-content, .markdown-preview-view")) return null;

		const text = view.getViewData();
		let quote: string;
		let offset: number;
		if (view.getMode() === "source") {
			quote = view.editor.getSelection();
			offset = view.editor.posToOffset(view.editor.getCursor("from"));
			if (offset < frontMatterEnd(text)) return null;
		} else {
			quote = selection.toString();
			offset = quotePosition(text, quote)?.from ?? -1;
		}
		if (!quote.trim()) return null;
		const anchor = offset >= 0 ? commentAnchor(text, offset, quote) : { ...headingInPreview(start), quote: quote.trim() };
		return { file: view.file, anchor, rect: range.getBoundingClientRect() };
	}

	/** Shows or hides the comment button over the selection (CMNT-3). */
	selectionChanged() {
		if (this.popover) return;
		const selected = this.selection();
		if (!selected?.rect || (selected.rect.width === 0 && selected.rect.height === 0)) {
			this.hideButton();
			return;
		}
		this.selected = selected;
		if (!this.button) {
			this.button = document.body.createEl("button", { cls: "clickable-icon theory-comment-button", attr: { "aria-label": "Comment" } });
			setIcon(this.button, "message-square-plus");
			// Keeps the selection when the button is pressed.
			this.button.addEventListener("mousedown", (event) => event.preventDefault());
			this.button.addEventListener("click", () => {
				if (this.selected) this.openPopover(this.selected);
			});
		}
		const { rect } = selected;
		this.button.style.left = `${Math.max(4, rect.left + rect.width / 2 - 14)}px`;
		this.button.style.top = `${Math.max(4, rect.top - 34)}px`;
		this.button.show();
	}

	private hideButton() {
		this.button?.hide();
		this.selected = null;
	}

	/** The command "Comment on selection" (CMNT-6). */
	commentOnSelection() {
		const selected = this.selection() ?? this.editorSelection();
		if (!selected) {
			new Notice("Select the text to comment on first.");
			return;
		}
		this.openPopover(selected);
	}

	/** The active editor's selection, when the window's selection has moved elsewhere, e.g. to the command palette. */
	private editorSelection(): Selected | null {
		const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file || view.getMode() !== "source") return null;
		const quote = view.editor.getSelection();
		if (!quote.trim()) return null;
		const text = view.getViewData();
		const offset = view.editor.posToOffset(view.editor.getCursor("from"));
		if (offset < frontMatterEnd(text)) return null;
		return { file: view.file, anchor: commentAnchor(text, offset, quote), rect: null };
	}

	/** The popover with a text box, Cancel and Comment (CMNT-5). */
	private openPopover(selected: Selected) {
		this.closePopover();
		this.button?.hide();
		const popover = document.body.createDiv({ cls: "theory-comment-popover" });
		this.popover = popover;
		const box = popover.createEl("textarea", { attr: { rows: "3", placeholder: "Comment", "aria-label": "Comment" } });
		const buttons = popover.createDiv({ cls: "theory-comment-popover-buttons" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.closePopover());
		const send = buttons.createEl("button", { cls: "mod-cta", text: "Comment", attr: { "aria-label": "Comment (⌘/Ctrl + Enter)" } });

		const update = () => (send.disabled = box.value.trim() === "");
		const submit = async () => {
			if (send.disabled) return;
			send.disabled = true;
			const done = await this.act(selected.file.path, { kind: "comment", anchor: selected.anchor, text: box.value.trim() });
			if (done) {
				this.closePopover();
				this.plugin.showComments(null);
			} else {
				update();
			}
		};
		box.addEventListener("input", update);
		box.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				submit();
			} else if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				this.closePopover();
			}
		});
		send.addEventListener("click", submit);
		update();

		const rect = selected.rect;
		const width = 320;
		const left = rect ? rect.left + rect.width / 2 - width / 2 : window.innerWidth / 2 - width / 2;
		popover.style.width = `${width}px`;
		popover.style.left = `${Math.min(Math.max(8, left), window.innerWidth - width - 8)}px`;
		popover.style.top = `${rect ? Math.min(rect.top + 4, window.innerHeight - 180) : window.innerHeight / 3}px`;
		box.focus();
	}

	private closePopover() {
		this.popover?.remove();
		this.popover = null;
		this.hideButton();
	}

	removeAll() {
		this.closePopover();
		this.button?.remove();
		this.button = null;
	}
}

/** The nearest heading above `el` in Reading view, when the selected text isn't found as written in the note. */
function headingInPreview(el: HTMLElement): { heading?: string } {
	let block: Element | null = el.closest(".markdown-preview-sizer > div") ?? el;
	while (block) {
		const headings = block.matches("h1, h2, h3, h4, h5, h6") ? [block] : Array.from(block.querySelectorAll("h1, h2, h3, h4, h5, h6"));
		const last = headings[headings.length - 1];
		if (last?.textContent?.trim() && last !== el) return { heading: last.textContent.trim() };
		block = block.previousElementSibling;
	}
	return {};
}
