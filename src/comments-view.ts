import { ItemView, MarkdownView, Notice, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { findAnchor } from "./anchor";
import { projectRepos } from "./branches";
import {
	type CommentFile,
	type NoteComment,
	type Thread,
	type ThreadGroup,
	groupThreads,
	listCommentFiles,
	readCommentFile,
	unreadableMessage,
} from "./comments";
import type TheoryPlugin from "./main";
import { duration } from "./pull";

export const COMMENTS_VIEW_TYPE = "theory-comments";

function ago(at: string): string {
	return `${duration(Date.now() - new Date(at).getTime())} ago`;
}

/**
 * The comments on every note in the vault, in the right sidebar, whichever note is open (CMNT-16 to
 * CMNT-22, CMNT-26 to CMNT-28). Every comment's text is set as plain text, never as Markdown or HTML.
 */
export class CommentsView extends ItemView {
	plugin: TheoryPlugin;
	// Ignores results from an older refresh that finishes after a newer one.
	private refreshId = 0;
	private focusThreadId: string | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: TheoryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return COMMENTS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Comments";
	}

	getIcon(): string {
		return "message-square";
	}

	async onOpen() {
		// A note's edits may move or change the text a thread is on (CMNT-20).
		const refreshSoon = debounce(() => this.refresh(), 1000, true);
		for (const event of ["modify", "create", "delete", "rename"] as const) {
			this.registerEvent(this.app.vault.on(event as "modify", refreshSoon));
		}
		await this.refresh();
	}

	/** Shows the thread, after the view has drawn every note's comments (CMNT-24). */
	async showThread(threadId: string) {
		this.focusThreadId = threadId;
		await this.refresh();
	}

	async refresh() {
		const id = ++this.refreshId;
		const { contentEl } = this;
		let vaultPath: string;
		try {
			vaultPath = this.plugin.getVaultPath();
		} catch {
			return;
		}
		const modelFolders = projectRepos(this.plugin.settings.projectFolder).map((repo) => repo.name);
		const notes: { note: string; file: CommentFile; text: string | null }[] = [];
		const broken: string[] = [];
		for (const { note, path } of await listCommentFiles(vaultPath, modelFolders)) {
			const read = await readCommentFile(vaultPath, path);
			if (read.kind === "broken") {
				broken.push(unreadableMessage(note, path));
				continue;
			}
			if (read.kind !== "ok") continue;
			const noteFile = this.app.vault.getAbstractFileByPath(note);
			const text = noteFile instanceof TFile ? await this.app.vault.cachedRead(noteFile) : null;
			notes.push({ note, file: read.file, text });
		}
		if (id !== this.refreshId) return;

		contentEl.empty();
		contentEl.addClass("theory-comments");
		for (const message of broken) contentEl.createDiv({ cls: "theory-comments-broken", text: message });

		const { open, resolved } = groupThreads(notes);
		if (open.length === 0 && resolved.length === 0) {
			if (broken.length === 0) this.message("No comments yet. Select text in a note to comment.");
			return;
		}

		const list = contentEl.createDiv({ cls: "theory-comments-list" });
		for (const group of open) this.renderGroup(list, group);
		if (resolved.length > 0) {
			const count = resolved.reduce((n, group) => n + group.threads.length, 0);
			const fold = contentEl.createEl("details", { cls: "theory-comments-resolved" });
			fold.createEl("summary", { text: `${count} resolved` });
			for (const group of resolved) this.renderGroup(fold, group);
			if (this.focusThreadId && resolved.some((g) => g.threads.some((t) => t.thread.id === this.focusThreadId))) fold.open = true;
		}

		if (this.focusThreadId) {
			const target = contentEl.querySelector<HTMLElement>(`[data-thread="${CSS.escape(this.focusThreadId)}"]`);
			target?.scrollIntoView({ block: "center" });
			target?.addClass("is-focused");
			window.setTimeout(() => target?.removeClass("is-focused"), 1500);
			this.focusThreadId = null;
		}
	}

	private message(text: string) {
		this.contentEl.createDiv({ cls: "theory-comments-empty", text });
	}

	private renderGroup(parent: HTMLElement, group: ThreadGroup) {
		const el = parent.createDiv({ cls: "theory-comments-group" });
		const title = el.createDiv({ cls: "theory-comments-note", text: group.label, attr: { title: group.note } });
		// The note's path opens the note at the top (CMNT-28).
		title.addEventListener("click", () => this.openNote(group.note, null));
		for (const { thread, at } of group.threads) {
			this.renderThread(el, group.note, thread, thread.resolved === null && at === null);
		}
	}

	/**
	 * Opens the note in the editor. With a thread, scrolls to its quote and selects it (CMNT-26); when the
	 * quote is gone, opens at the anchor's heading, else at the top, and selects nothing (CMNT-27).
	 */
	private async openNote(notePath: string, thread: Thread | null) {
		const { vault, workspace } = this.app;
		const file = vault.getAbstractFileByPath(notePath);
		if (!(file instanceof TFile)) {
			new Notice(`${notePath} isn't in the vault any more.`);
			return;
		}
		const existing = workspace
			.getLeavesOfType("markdown")
			.find((leaf) => leaf.view instanceof MarkdownView && leaf.view.file === file);
		const leaf = existing ?? workspace.getLeaf(false);
		if (existing) workspace.setActiveLeaf(existing, { focus: true });
		else await leaf.openFile(file);
		let view = leaf.view;
		if (!(view instanceof MarkdownView)) return;
		// Selecting text needs the editor, not Reading view.
		if (view.getMode() !== "source") {
			const state = leaf.getViewState();
			await leaf.setViewState({ ...state, state: { ...state.state, mode: "source" } });
			view = leaf.view;
			if (!(view instanceof MarkdownView)) return;
		}
		const text = view.getViewData();
		const { editor } = view;
		const quote = thread ? findAnchor(text, { path: notePath, quote: thread.anchor.quote }) : null;
		const heading = !quote && thread?.anchor.heading ? findAnchor(text, { path: notePath, heading: thread.anchor.heading }) : null;
		const from = editor.offsetToPos(quote?.from ?? heading?.from ?? 0);
		const to = quote ? editor.offsetToPos(quote.to) : from;
		editor.setSelection(from, to);
		editor.scrollIntoView({ from, to }, true);
		editor.focus();
	}

	private renderThread(parent: HTMLElement, notePath: string, thread: Thread, changed: boolean) {
		const el = parent.createDiv({ cls: "theory-comment-thread", attr: { "data-thread": thread.id } });
		const quote = el.createDiv({ cls: "theory-comment-quote", text: thread.anchor.quote });
		quote.addEventListener("click", () => this.openNote(notePath, thread));
		if (changed) el.createDiv({ cls: "theory-comment-changed", text: "The text this was on has changed." });

		const [first, ...replies] = thread.comments;
		if (first) this.renderComment(el, first);
		if (replies.length > 0) {
			const list = el.createDiv({ cls: "theory-comment-replies" });
			for (const reply of replies) this.renderComment(list, reply);
		}

		if (thread.resolved) {
			el.createDiv({ cls: "theory-comment-resolved-by", text: `Resolved by ${thread.resolved.by.name}, ${ago(thread.resolved.at)}` });
			const actions = el.createDiv({ cls: "theory-comment-actions" });
			actions.createEl("button", { text: "Reopen" }).addEventListener("click", () =>
				this.plugin.comments.act(notePath, { kind: "reopen", threadId: thread.id }),
			);
			return;
		}

		const reply = el.createEl("textarea", {
			cls: "theory-comment-reply",
			attr: { rows: "1", placeholder: "Reply", "aria-label": "Reply" },
		});
		const actions = el.createDiv({ cls: "theory-comment-actions" });
		const send = actions.createEl("button", { cls: "mod-cta", text: "Reply" });
		actions.createEl("button", { text: "Resolve" }).addEventListener("click", () =>
			this.plugin.comments.act(notePath, { kind: "resolve", threadId: thread.id }),
		);
		const update = () => (send.disabled = reply.value.trim() === "");
		const submit = async () => {
			if (send.disabled) return;
			send.disabled = true;
			const done = await this.plugin.comments.act(notePath, { kind: "reply", threadId: thread.id, text: reply.value.trim() });
			if (!done) update();
		};
		reply.addEventListener("input", update);
		reply.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				submit();
			}
		});
		send.addEventListener("click", submit);
		update();
	}

	private renderComment(parent: HTMLElement, comment: NoteComment) {
		const el = parent.createDiv({ cls: "theory-comment" });
		const meta = el.createDiv({ cls: "theory-comment-meta" });
		meta.createSpan({ cls: "theory-comment-author", text: comment.author.name, attr: { title: comment.author.email } });
		meta.createSpan({ cls: "theory-comment-time", text: ago(comment.at), attr: { title: new Date(comment.at).toLocaleString() } });
		el.createDiv({ cls: "theory-comment-text", text: comment.text });
	}
}
