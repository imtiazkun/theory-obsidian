import { Notice, TFile, setIcon, setTooltip } from "obsidian";
import { commitIcon } from "./commit";
import { projectRepos } from "./branches";
import { pendingRevisionCount, timeLeft } from "./compile";
import { expandRepoFor } from "./expand";
import type TheoryPlugin from "./main";
import { syncStatus } from "./pull";
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
 * Floating bar at the bottom right of the editor area: the sync status, an icon-only commit button
 * and a compile button that shows what Compile would do.
 */
export class CompileButton {
	private barEl: HTMLElement;
	private syncEl: HTMLButtonElement;
	private syncLabelEl: HTMLElement;
	private syncIconEl: HTMLElement;
	private commitEl: HTMLButtonElement;
	private expandEl: HTMLButtonElement;
	private expandLabelEl: HTMLElement;
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
	// Counts down with a waiting permission card.
	private ticker: number | null = null;

	constructor(private plugin: TheoryPlugin) {
		this.barEl = createDiv({ cls: "theory-action-bar" });

		// The sync status, left of the commit button, only when the vault has an origin (PULL-9).
		this.syncEl = this.barEl.createEl("button", { cls: "theory-fab theory-sync-fab" });
		this.syncIconEl = this.syncEl.createSpan({ cls: "theory-compile-fab-icon" });
		this.syncLabelEl = this.syncEl.createSpan({ cls: "theory-compile-fab-label" });
		this.syncEl.addEventListener("click", () => {
			if (!this.plugin.puller.state.running) this.plugin.pullNow();
		});

		this.commitEl = this.barEl.createEl("button", { cls: "theory-fab theory-commit-fab" });
		setIcon(this.commitEl, commitIcon());
		this.commitEl.addEventListener("click", () => this.onCommitClick());

		// Shows only on a model folder's index.md (EXP-1).
		this.expandEl = this.barEl.createEl("button", { cls: "theory-fab theory-expand-fab" });
		setIcon(this.expandEl.createSpan({ cls: "theory-compile-fab-icon" }), "sparkles");
		this.expandLabelEl = this.expandEl.createSpan({ cls: "theory-compile-fab-label" });
		this.expandEl.addEventListener("click", () => this.onExpandClick());

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
		this.ticker ??= window.setInterval(() => {
			if (this.state.compile.kind === "running") this.render();
			else if (this.state.compile.kind !== "hidden") this.renderSync();
		}, 1000);
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
		if (this.ticker !== null) window.clearInterval(this.ticker);
		this.ticker = null;
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

	/** Redraws without reading git again, e.g. when a permission request opens or closes. */
	render() {
		const { compile } = this.state;
		this.barEl.toggle(compile.kind !== "hidden");
		if (compile.kind === "hidden") return;
		this.renderSync();
		this.renderCommit();
		this.renderExpand();
		this.renderCompile(compile);
	}

	/** The repository the active note is the model index of, or null. */
	private expandRepo(): string | null {
		const repos = projectRepos(this.plugin.settings.projectFolder).map((repo) => repo.name);
		return expandRepoFor(this.plugin.app.workspace.getActiveFile()?.path, repos);
	}

	private renderExpand() {
		const repo = this.expandRepo();
		this.expandEl.toggle(repo !== null);
		if (!repo) return;
		const running = this.plugin.isExpanding(repo);
		this.expandLabelEl.setText(running ? "Expanding…" : "Expand");
		this.expandEl.setAttr("aria-disabled", String(running));
		setTooltip(
			this.expandEl,
			running ? `Claude is looking for notes ${repo} is missing.` : `Ask Claude which notes the ${repo} model is missing.`,
			{ placement: "top" },
		);
	}

	private onExpandClick() {
		const repo = this.expandRepo();
		if (repo && !this.plugin.isExpanding(repo)) this.plugin.expand(repo);
	}

	private renderSync() {
		const status = syncStatus(this.plugin.puller.state, Date.now());
		this.syncEl.toggle(status !== null);
		if (!status) return;
		for (const kind of ["pulling", "synced", "waiting", "diverged", "offline"]) this.syncEl.toggleClass(`is-${kind}`, status.kind === kind);
		const icons: Record<string, string> = {
			pulling: "loader",
			synced: "cloud",
			waiting: "clock",
			diverged: "git-compare-arrows",
			offline: "cloud-off",
		};
		setIcon(this.syncIconEl, icons[status.kind] ?? "cloud");
		this.syncLabelEl.setText(status.label);
		this.syncEl.setAttr("aria-disabled", String(status.kind === "pulling"));
		setTooltip(this.syncEl, status.tooltip, { placement: "top" });
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
		this.compileEl.removeClass("is-asking");
		this.badgeEl.empty();
		this.badgeEl.hide();

		const uncommitted = this.state.changed.length;
		const uncommittedNote =
			uncommitted > 0 ? `\n${plural(uncommitted, "file has", "files have")} uncommitted changes, which won't be compiled.` : "";

		switch (compile.kind) {
			case "running": {
				// The oldest waiting permission card, which the report scrolls to.
				const [request] = this.plugin.permissionRequests();
				this.compileEl.toggleClass("is-asking", Boolean(request));
				if (request) {
					this.show(
						"message-circle-question",
						`Claude is asking (${timeLeft(request.expiresAt)})`,
						`Claude is asking to use ${request.tool}. Click to answer in the compile report.`,
					);
				} else {
					this.show("loader", "Compiling…", "A compile is running. Click to follow it.");
				}
				break;
			}
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
			case "running":
				// Opens the report at the waiting card, if there is one.
				this.plugin.showLatestReport();
				break;
			default:
				this.plugin.showReportView();
		}
	}
}
