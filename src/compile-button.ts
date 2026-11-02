import { Notice, TFile, setIcon, setTooltip } from "obsidian";
import { commitIcon } from "./commit";
import { pendingRevisionCount } from "./compile";
import type TheoryPlugin from "./main";
import { changedFiles } from "./vault";

type CompileState =
	| { kind: "hidden" }
	| { kind: "running" }
	| { kind: "setup" }
	| { kind: "ready"; pending: number }
	| { kind: "failed" }
	| { kind: "idle" };

interface BarState {
	compile: CompileState;
	/** Model files with uncommitted changes. */
	changed: string[];
}

const COMPILE_KINDS = ["running", "setup", "ready", "failed", "idle"] as const;

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

/**
 * Floating bar at the bottom right of the editor area: an icon-only commit button and a
 * compile button that shows what Compile would do.
 */
export class CompileButton {
	private barEl: HTMLElement;
	private commitEl: HTMLButtonElement;
	private compileEl: HTMLButtonElement;
	private iconEl: HTMLElement;
	private labelEl: HTMLElement;
	private badgeEl: HTMLElement;
	private state: BarState = { compile: { kind: "hidden" }, changed: [] };
	// Ignores results from an older refresh that finishes after a newer one.
	private refreshId = 0;
	private observed: HTMLElement | null = null;
	private movedStatusBar: HTMLElement | null = null;
	private resizeObserver = new ResizeObserver(() => this.position());
	private onWindowResize = () => this.position();

	constructor(private plugin: TheoryPlugin) {
		this.barEl = createDiv({ cls: "theory-action-bar" });

		this.commitEl = this.barEl.createEl("button", { cls: "theory-fab theory-commit-fab" });
		setIcon(this.commitEl, commitIcon());
		this.commitEl.addEventListener("click", () => this.onCommitClick());

		this.compileEl = this.barEl.createEl("button", { cls: "theory-fab theory-compile-fab" });
		this.iconEl = this.compileEl.createSpan({ cls: "theory-compile-fab-icon" });
		this.labelEl = this.compileEl.createSpan({ cls: "theory-compile-fab-label" });
		this.badgeEl = this.compileEl.createSpan({ cls: "theory-compile-fab-badge" });
		this.compileEl.addEventListener("click", () => this.onCompileClick());

		this.render();
	}

	/**
	 * Floats the bar over the bottom right of the editor area. It lives on the body,
	 * because inside the editor's flex layout Obsidian treats it as another pane.
	 */
	attach() {
		if (!this.barEl.isConnected) {
			document.body.appendChild(this.barEl);
			window.addEventListener("resize", this.onWindowResize);
		}
		// The root split's element isn't in Obsidian's public types, though every split has one.
		const root = this.plugin.app.workspace.rootSplit as unknown as { containerEl: HTMLElement };
		if (this.observed !== root.containerEl) {
			if (this.observed) this.resizeObserver.unobserve(this.observed);
			this.observed = root.containerEl;
			this.resizeObserver.observe(root.containerEl);
		}
		this.position();
	}

	detach() {
		this.resizeObserver.disconnect();
		this.observed = null;
		window.removeEventListener("resize", this.onWindowResize);
		this.restoreStatusBar();
		this.barEl.remove();
	}

	/** Keeps the bar in the editor area's corner as sidebars open, close and resize. */
	private position() {
		if (!this.observed) return;
		const rect = this.observed.getBoundingClientRect();
		const shown = this.state.compile.kind !== "hidden";
		if (shown) this.moveStatusBar(rect.left);
		else this.restoreStatusBar();

		// If the status bar still ends up under the bar, sit above it.
		let bottom = rect.bottom;
		const bar = document.body.querySelector<HTMLElement>(".status-bar");
		if (bar && bar.getClientRects().length > 0) {
			const barRect = bar.getBoundingClientRect();
			const left = rect.right - this.barEl.offsetWidth - 32;
			if (barRect.top < bottom && barRect.right > left) bottom = barRect.top;
		}
		this.barEl.style.right = `${window.innerWidth - rect.right}px`;
		this.barEl.style.bottom = `${window.innerHeight - bottom}px`;
		this.barEl.toggleClass("is-offscreen", rect.width === 0 || rect.height === 0);
	}

	/** Moves Obsidian's status bar to the editor's bottom left, so the right corner is free. */
	private moveStatusBar(left: number) {
		const bar = document.body.querySelector<HTMLElement>(".status-bar");
		if (!bar) return;
		if (this.movedStatusBar && this.movedStatusBar !== bar) this.restoreStatusBar();
		this.movedStatusBar = bar;
		bar.style.setProperty("inset-inline-end", "auto");
		bar.style.setProperty("right", "auto");
		bar.style.setProperty("left", `${left}px`);
		// Mirror the rounded corner and border so the bar hugs the left edge instead.
		bar.style.setProperty("--status-bar-radius", "0 var(--radius-m) 0 0");
		bar.style.setProperty("--status-bar-border-width", "1px 1px 0 0");
	}

	private restoreStatusBar() {
		const bar = this.movedStatusBar;
		if (!bar) return;
		for (const property of ["inset-inline-end", "right", "left", "--status-bar-radius", "--status-bar-border-width"]) {
			bar.style.removeProperty(property);
		}
		this.movedStatusBar = null;
	}

	async refresh() {
		const id = ++this.refreshId;
		const state = await this.readState().catch((): BarState => ({ compile: { kind: "hidden" }, changed: [] }));
		if (id !== this.refreshId) return;
		this.state = state;
		this.render();
		this.position();
	}

	private async readState(): Promise<BarState> {
		const { plugin } = this;
		if (!plugin.settings.showCompileButton || !plugin.isVaultSetUp()) {
			return { compile: { kind: "hidden" }, changed: [] };
		}
		const vaultPath = plugin.getVaultPath();
		const changed = await changedFiles(vaultPath);

		if (plugin.isCompiling()) return { compile: { kind: "running" }, changed };
		if (!plugin.settings.projectFolder) return { compile: { kind: "setup" }, changed };
		const pending = await pendingRevisionCount(vaultPath);
		if (pending > 0) return { compile: { kind: "ready", pending }, changed };
		if (plugin.reports[0]?.status === "failed") return { compile: { kind: "failed" }, changed };
		return { compile: { kind: "idle" }, changed };
	}

	private render() {
		const { compile } = this.state;
		this.barEl.toggle(compile.kind !== "hidden");
		if (compile.kind === "hidden") return;
		this.renderCommit();
		this.renderCompile(compile);
	}

	private renderCommit() {
		const { changed } = this.state;
		const active = this.activeChangedFile();
		const dirty = changed.length > 0;
		this.commitEl.toggleClass("is-dirty", dirty);
		this.commitEl.setAttr("aria-disabled", String(!dirty));
		setTooltip(
			this.commitEl,
			active
				? `Commit changes to ${active.basename}`
				: dirty
					? `Commit ${plural(changed.length, "changed file", "changed files")}`
					: "No changes to commit",
			{ placement: "top" },
		);
	}

	private renderCompile(compile: Exclude<CompileState, { kind: "hidden" }>) {
		for (const kind of COMPILE_KINDS) this.compileEl.toggleClass(`is-${kind}`, compile.kind === kind);
		this.badgeEl.empty();
		this.badgeEl.hide();

		const uncommitted = this.state.changed.length;
		const uncommittedNote =
			uncommitted > 0 ? `\n${plural(uncommitted, "file has", "files have")} uncommitted changes, which won't be compiled.` : "";

		switch (compile.kind) {
			case "running":
				this.show("loader", "Compiling…", "A compile is running. Click to follow it.");
				break;
			case "setup":
				this.show("settings", "Set up Compile", "Choose the project folder this model compiles into.");
				break;
			case "ready":
				this.show(
					"hammer",
					"Compile",
					`Compile ${plural(compile.pending, "new revision", "new revisions")} into the code.${uncommittedNote}`,
				);
				this.badgeEl.setText(String(compile.pending));
				this.badgeEl.show();
				break;
			case "failed":
				this.show("alert-triangle", "Last compile failed", `Click to see what went wrong.${uncommittedNote}`);
				break;
			case "idle":
				this.show(
					"check",
					"Up to date",
					`Every committed revision is compiled.${uncommittedNote || "\nCommit changes to the model to compile them."}`,
				);
				break;
		}
	}

	private show(icon: string, label: string, tooltip: string) {
		setIcon(this.iconEl, icon);
		this.labelEl.setText(label);
		setTooltip(this.compileEl, tooltip, { placement: "top" });
	}

	/** The open note, when it has uncommitted changes. */
	private activeChangedFile(): TFile | null {
		const file = this.plugin.app.workspace.getActiveFile();
		return file && this.state.changed.includes(file.path) ? file : null;
	}

	private onCommitClick() {
		const active = this.activeChangedFile();
		if (active) this.plugin.openCommitModal(active);
		else if (this.state.changed.length > 0) this.plugin.openCommitAllModal();
		else new Notice("No changes to commit");
	}

	private onCompileClick() {
		switch (this.state.compile.kind) {
			case "ready":
				this.plugin.compile();
				break;
			case "setup":
				this.plugin.openSettings();
				break;
			default:
				this.plugin.showReportView();
		}
	}
}
