import { ItemView, ViewStateResult, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import { type FileDiff, type PastCommit, initialTicks, keptTicks, pastCommit, ruleChangesLabel, workingDiff } from "./commit-diff";
import { commitIcon } from "./commit";
import type TheoryPlugin from "./main";
import { type Change, type ChangeKind, type Identity, changes, requireIdentity } from "./vault";

export const COMMIT_VIEW_TYPE = "theory-commit";
export const PAST_COMMIT_VIEW_TYPE = "theory-past-commit";

const KIND_LABELS: Record<ChangeKind, string> = {
	modified: "modified",
	new: "new",
	deleted: "deleted",
	renamed: "renamed",
};

/** The message box's placeholder (CMT-16). */
export const MESSAGE_PLACEHOLDER = "Say why. Git already shows what changed.";

/** Draws one file's name, how it changed, its rule changes and its diff, as raw text (CMT-20 to CMT-22, CMT-24). */
function renderFile(parent: HTMLElement, file: FileDiff, checkbox?: HTMLInputElement) {
	const el = parent.createDiv({ cls: "theory-commit-diff-file" });
	const head = el.createDiv({ cls: "theory-commit-diff-head" });
	if (checkbox) head.appendChild(checkbox);
	head.createSpan({ cls: "theory-commit-diff-path", text: file.path });
	head.createSpan({ cls: `theory-commit-diff-kind is-${file.kind}`, text: KIND_LABELS[file.kind] });
	if (file.oldPath) el.createDiv({ cls: "theory-commit-diff-rename", text: `${file.oldPath} → ${file.path}` });
	if (file.binary) return;
	const rules = file.rules ? ruleChangesLabel(file.rules) : "";
	if (rules) el.createDiv({ cls: "theory-commit-diff-rules", text: rules });
	if (file.hunks.length === 0) return;

	const body = el.createDiv({ cls: "theory-commit-diff-body" });
	for (const hunk of file.hunks) {
		if (hunk.foldedBefore > 0) {
			const n = hunk.foldedBefore;
			body.createDiv({ cls: "theory-commit-diff-fold", text: `${n} unchanged ${n === 1 ? "line" : "lines"}` });
		}
		for (const line of hunk.lines) {
			const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
			// setText only: the diff is never rendered as Markdown or HTML (CMT-24).
			body.createDiv({ cls: `theory-commit-diff-line is-${line.kind}`, text: `${sign} ${line.text}` });
		}
	}
}

/**
 * The Commit page for new changes (CMT-17 to CMT-24, CMT-6, CMT-7, CMT-9, CMT-10). Lists every changed file
 * with a checkbox and its diff, and commits exactly the ticked files (CMT-12).
 */
export class CommitView extends ItemView {
	plugin: TheoryPlugin;
	private ticked: string[] = [];
	private changed: Change[] = [];
	private listEl!: HTMLElement;
	private signerEl!: HTMLElement;
	private message!: HTMLTextAreaElement;
	private submit!: HTMLButtonElement;
	private generate!: HTMLButtonElement;
	private committing = false;
	// Ignores results from an older refresh that finishes after a newer one.
	private refreshId = 0;

	constructor(leaf: WorkspaceLeaf, plugin: TheoryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return COMMIT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Commit";
	}

	getIcon(): string {
		return commitIcon();
	}

	getState(): Record<string, unknown> {
		return { ticked: this.ticked };
	}

	async setState(state: unknown, result: ViewStateResult) {
		const ticked = (state as { ticked?: unknown } | null)?.ticked;
		if (Array.isArray(ticked)) this.ticked = ticked.filter((p): p is string => typeof p === "string");
		await super.setState(state, result);
		await this.refresh();
	}

	/** Starts the page over for a new commit: which files are ticked (CMT-19). */
	async start(from: string | "all") {
		const changed = await changes(this.plugin.getVaultPath()).catch(() => [] as Change[]);
		this.ticked = initialTicks(
			changed.map((c) => c.path),
			from,
		);
		await this.refresh();
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("theory-commit-page");

		const top = contentEl.createDiv({ cls: "theory-commit-top" });
		const box = top.createDiv({ cls: "theory-commit-message-box" });
		this.message = box.createEl("textarea", {
			cls: "theory-commit-message",
			attr: { rows: "3", placeholder: MESSAGE_PLACEHOLDER, "aria-label": "Commit message" },
		});
		this.generate = box.createEl("button", {
			cls: "clickable-icon theory-commit-generate",
			attr: { "aria-label": "Write the message with Claude" },
		});
		setIcon(this.generate, "sparkles");
		this.generate.addEventListener("click", () => this.writeMessage());

		const footer = top.createDiv({ cls: "theory-commit-footer" });
		this.signerEl = footer.createDiv({ cls: "theory-commit-author" });
		const buttons = footer.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.leaf.detach());
		this.submit = buttons.createEl("button", { cls: "mod-cta", text: "Commit", attr: { "aria-label": "Commit (⌘/Ctrl + Enter)" } });
		this.submit.addEventListener("click", () => this.commit());

		this.listEl = contentEl.createDiv({ cls: "theory-commit-files" });

		this.message.addEventListener("input", () => this.updateButtons());
		this.registerDomEvent(contentEl, "keydown", (event) => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				this.commit();
			}
		});

		// The page shows the files as they are now (CMT-23).
		const refreshSoon = debounce(() => this.refresh(), 500, true);
		for (const event of ["modify", "create", "delete", "rename"] as const) {
			this.registerEvent(this.app.vault.on(event as "modify", refreshSoon));
		}
		this.registerDomEvent(window, "focus", refreshSoon);
		await this.refresh();
		this.message.focus();
	}

	private updateButtons() {
		if (!this.submit) return;
		// Disabled until the box holds text and a file is ticked (CMT-7, CMT-10).
		this.submit.disabled = this.committing || this.message.value.trim() === "" || this.ticked.length === 0;
		if (!this.generate.hasClass("is-generating")) this.generate.disabled = this.ticked.length === 0;
	}

	async refresh() {
		if (!this.listEl) return;
		const id = ++this.refreshId;
		const vaultPath = this.plugin.getVaultPath();
		let signer: Identity | null = null;
		let signerError = "";
		let files: FileDiff[] = [];
		let changed: Change[] = [];
		try {
			changed = await changes(vaultPath);
			files = await Promise.all(changed.map((change) => workingDiff(vaultPath, change)));
		} catch (error) {
			if (id !== this.refreshId) return;
			this.listEl.empty();
			this.listEl.createDiv({ cls: "theory-commit-empty", text: `Couldn't read changes: ${error instanceof Error ? error.message : String(error)}` });
			return;
		}
		try {
			signer = await requireIdentity(vaultPath);
		} catch (error) {
			signerError = error instanceof Error ? error.message : String(error);
		}
		if (id !== this.refreshId) return;

		this.changed = changed;
		this.ticked = keptTicks(
			this.ticked,
			changed.map((c) => c.path),
		);
		this.signerEl.setText(signer ? `Signed as ${signer.name} <${signer.email}>` : signerError);

		this.listEl.empty();
		if (files.length === 0) {
			this.listEl.createDiv({ cls: "theory-commit-empty", text: "No changes to commit" });
		}
		for (const file of files) {
			const checkbox = createEl("input", { attr: { type: "checkbox", "aria-label": `Include ${file.path}` } });
			checkbox.checked = this.ticked.includes(file.path);
			checkbox.addEventListener("change", () => {
				this.ticked = checkbox.checked
					? [...this.ticked.filter((p) => p !== file.path), file.path]
					: this.ticked.filter((p) => p !== file.path);
				this.updateButtons();
			});
			renderFile(this.listEl, file, checkbox);
		}
		this.updateButtons();
	}

	/** Asks Claude to write the message from the ticked files; its message replaces the box's text (CMT-7, CMT-15). */
	private async writeMessage() {
		if (this.generate.disabled || this.ticked.length === 0) return;
		this.generate.disabled = true;
		this.generate.addClass("is-generating");
		const generated = await this.plugin.generateCommitMessage([...this.ticked]);
		this.generate.removeClass("is-generating");
		this.updateButtons();
		if (generated === null) return;
		this.message.value = generated;
		this.updateButtons();
		this.message.focus();
	}

	private async commit() {
		this.updateButtons();
		if (this.submit.disabled) return;
		this.committing = true;
		this.submit.setText("Committing…");
		this.updateButtons();
		const ticked = this.changed.map((c) => c.path).filter((path) => this.ticked.includes(path));
		const done = await this.plugin.commitChanges(this.message.value.trim(), ticked);
		this.committing = false;
		if (done) {
			// The page closes after a commit (CMT-13).
			this.leaf.detach();
			return;
		}
		this.submit.setText("Commit");
		this.updateButtons();
	}
}

/**
 * A past commit on the Commit page, read-only (CMT-25 to CMT-29): its message, author, date and short hash,
 * and every file it changed with its own diff. No checkboxes, no message box, no Commit button.
 */
export class PastCommitView extends ItemView {
	plugin: TheoryPlugin;
	private hash = "";
	private path = "";
	private loadId = 0;

	constructor(leaf: WorkspaceLeaf, plugin: TheoryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return PAST_COMMIT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.hash ? `Commit ${this.hash.slice(0, 7)}` : "Commit";
	}

	getIcon(): string {
		return commitIcon();
	}

	getState(): Record<string, unknown> {
		return { hash: this.hash, path: this.path };
	}

	async setState(state: unknown, result: ViewStateResult) {
		const { hash, path } = (state ?? {}) as { hash?: unknown; path?: unknown };
		if (typeof hash === "string") this.hash = hash;
		if (typeof path === "string") this.path = path;
		await super.setState(state, result);
		await this.loadCommit();
	}

	async onOpen() {
		this.contentEl.addClass("theory-commit-page", "is-read-only");
		await this.loadCommit();
	}

	private async loadCommit() {
		const id = ++this.loadId;
		const { contentEl } = this;
		if (!this.hash) return;
		let commit: PastCommit;
		try {
			commit = await pastCommit(this.plugin.getVaultPath(), this.hash, this.path || undefined);
		} catch (error) {
			if (id !== this.loadId) return;
			contentEl.empty();
			contentEl.createDiv({ cls: "theory-commit-empty", text: `Couldn't read this commit: ${error instanceof Error ? error.message : String(error)}` });
			return;
		}
		if (id !== this.loadId) return;
		contentEl.empty();
		const head = contentEl.createDiv({ cls: "theory-commit-top" });
		head.createDiv({ cls: "theory-commit-past-message", text: commit.message });
		const meta = head.createDiv({ cls: "theory-commit-author" });
		meta.setText(`${commit.author} <${commit.email}> · ${commit.date.toLocaleString()} · ${commit.shortHash}`);
		const list = contentEl.createDiv({ cls: "theory-commit-files" });
		for (const file of commit.files) renderFile(list, file);
		if (commit.files.length === 0) list.createDiv({ cls: "theory-commit-empty", text: "This commit changed no files." });
		// The tab's title names the commit.
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
	}
}
