import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import { type NoteComment, type Thread, orderThreads, unreadableMessage } from "./comments";
import type TheoryPlugin from "./main";
import { duration } from "./pull";

export const COMMENTS_VIEW_TYPE = "theory-comments";

function ago(at: string): string {
	return `${duration(Date.now() - new Date(at).getTime())} ago`;
}

/**
 * The comments on the active note, in the right sidebar (CMNT-16 to CMNT-22). Every comment's text is
 * set as plain text, never as Markdown or HTML.
 */
export class CommentsView extends ItemView {
	plugin: TheoryPlugin;
	private file: TFile | null = null;
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
		this.registerEvent(this.app.workspace.on("file-open", () => this.refresh()));
		await this.refresh();
	}

	/** Shows the thread, after the view has drawn the note's comments (CMNT-24). */
	async showThread(threadId: string) {
		this.focusThreadId = threadId;
		await this.refresh();
	}

	async refresh() {
		const id = ++this.refreshId;
		const active = this.app.workspace.getActiveFile();
		// Clicking into the sidebar keeps the note it showed.
		if (active?.extension === "md") this.file = active;
		else if (active === null) this.file = null;
		const file = this.file && this.app.vault.getAbstractFileByPath(this.file.path) instanceof TFile ? this.file : null;

		const { contentEl } = this;
		if (!file) {
			if (id !== this.refreshId) return;
			contentEl.empty();
			contentEl.addClass("theory-comments");
			this.message("Open a note to see its comments.");
			return;
		}
		const read = await this.plugin.comments.read(file.path);
		const text = await this.app.vault.cachedRead(file);
		if (id !== this.refreshId) return;
		contentEl.empty();
		contentEl.addClass("theory-comments");

		if (read.kind === "broken") {
			this.message(unreadableMessage(read.path));
			return;
		}
		if (read.kind === "none" || read.file.threads.length === 0) {
			this.message("No comments on this note. Select text to comment.");
			return;
		}

		const { open, resolved } = orderThreads(read.file, text);
		const list = contentEl.createDiv({ cls: "theory-comments-list" });
		for (const { thread, at } of open) this.renderThread(list, file, thread, at === null);
		if (resolved.length > 0) {
			const fold = contentEl.createEl("details", { cls: "theory-comments-resolved" });
			fold.createEl("summary", { text: `${resolved.length} resolved` });
			for (const thread of resolved) this.renderThread(fold, file, thread, false);
			if (this.focusThreadId && resolved.some((t) => t.id === this.focusThreadId)) fold.open = true;
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

	private renderThread(parent: HTMLElement, file: TFile, thread: Thread, changed: boolean) {
		const el = parent.createDiv({ cls: "theory-comment-thread", attr: { "data-thread": thread.id } });
		el.createDiv({ cls: "theory-comment-quote", text: thread.anchor.quote });
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
				this.plugin.comments.act(file.path, { kind: "reopen", threadId: thread.id }),
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
			this.plugin.comments.act(file.path, { kind: "resolve", threadId: thread.id }),
		);
		const update = () => (send.disabled = reply.value.trim() === "");
		const submit = async () => {
			if (send.disabled) return;
			send.disabled = true;
			const done = await this.plugin.comments.act(file.path, { kind: "reply", threadId: thread.id, text: reply.value.trim() });
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
