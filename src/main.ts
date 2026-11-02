import { FileSystemAdapter, MarkdownView, Notice, Plugin, TAbstractFile, TFile, debounce } from "obsidian";
import { CommitButtons, CommitModal } from "./commit";
import { generateCommitMessage } from "./commit-message";
import { COMPILE_HISTORY_VIEW_TYPE, CompileHistoryView } from "./compile-history-view";
import { CompileButton } from "./compile-button";
import {
	CompileReport,
	CompileRun,
	NothingToCompileError,
	PermissionAnswer,
	PermissionRequest,
	startCompile,
} from "./compile";
import { CompileReportView, REPORT_VIEW_TYPE } from "./report-view";
import { DEFAULT_SETTINGS, TheorySettingTab, TheorySettings } from "./settings";
import { CommitHistoryView, HISTORY_VIEW_TYPE } from "./history-view";
import { plainProblem } from "./anchor";
import { FailureOverlay } from "./overlay";
import { NoteStatus } from "./note-status";
import { HiddenFolders } from "./explorer";
import { starterFiles } from "./starter";
import { authorName, changedFiles, commit, isVaultSetUp, setUpVault } from "./vault";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const MAX_REPORTS = 20;

export default class TheoryPlugin extends Plugin {
	settings: TheorySettings = { ...DEFAULT_SETTINGS };
	/** Compile reports, newest first. */
	reports: CompileReport[] = [];
	private commitButtons = new CommitButtons(this);
	private compileButton = new CompileButton(this);
	overlay = new FailureOverlay(this);
	private noteStatus = new NoteStatus(this);
	private hiddenFolders = new HiddenFolders(this);
	// Single user for now, so the compile lock only has to hold within this app.
	private compileRun: CompileRun | null = null;
	private statusBar: HTMLElement | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new TheorySettingTab(this.app, this));

		this.addCommand({
			id: "setup-vault",
			name: "Setup vault",
			callback: () => this.setUpVault(),
		});

		this.registerView(HISTORY_VIEW_TYPE, (leaf) => new CommitHistoryView(leaf, this));
		this.addCommand({
			id: "show-commit-history",
			name: "Show commit history",
			callback: () => this.showHistoryView(true),
		});
		this.registerView(COMPILE_HISTORY_VIEW_TYPE, (leaf) => new CompileHistoryView(leaf, this));
		this.registerView(REPORT_VIEW_TYPE, (leaf) => new CompileReportView(leaf, this));
		this.addCommand({
			id: "compile",
			name: "Compile",
			callback: () => this.compile(),
		});
		this.addCommand({
			id: "show-compile-report",
			name: "Show compile report",
			callback: () => this.showReportView(),
		});
		this.addRibbonIcon("hammer", "Compile the model", () => this.compile());
		this.statusBar = this.addStatusBarItem();
		this.statusBar.addClass("theory-status");
		this.statusBar.hide();

		// The layout is already ready when the plugin is turned on mid-session; only act on launch.
		const launching = !this.app.workspace.layoutReady;
		this.app.workspace.onLayoutReady(async () => {
			if (launching) await this.openIndex();
			await this.showHistoryView(false);
			await this.showCompileHistoryView();
			await this.commitButtons.sync();
			this.compileButton.attach();
			await this.compileButton.refresh();
			this.overlay.sync();
			await this.noteStatus.sync();
			this.hiddenFolders.attach();
		});
		// A file explorer opened later gets the same sorting.
		this.registerEvent(this.app.workspace.on("layout-change", () => this.hiddenFolders.attach()));

		const syncStatus = () => this.noteStatus.sync();
		const syncStatusSoon = debounce(syncStatus, 800, true);
		this.registerEvent(this.app.workspace.on("layout-change", syncStatus));
		this.registerEvent(this.app.workspace.on("file-open", syncStatus));
		// Fires when a note's front matter changes, e.g. after the realized box is clicked.
		this.registerEvent(this.app.metadataCache.on("changed", syncStatusSoon));
		this.registerDomEvent(window, "focus", syncStatusSoon);

		this.registerEditorExtension(this.overlay.editorExtension());
		const syncOverlay = () => this.overlay.sync();
		this.registerEvent(this.app.workspace.on("layout-change", syncOverlay));
		this.registerEvent(this.app.workspace.on("file-open", syncOverlay));
		this.registerEvent(this.app.vault.on("modify", debounce(syncOverlay, 1000, true)));

		this.addCommand({
			id: "commit-current-note",
			name: "Commit current note",
			callback: () => this.openCommitModal(this.app.workspace.getActiveFile()),
		});
		const syncButtons = () => this.commitButtons.sync();
		const syncButtonsSoon = debounce(syncButtons, 1000, true);
		this.registerEvent(this.app.workspace.on("layout-change", syncButtons));
		this.registerEvent(this.app.workspace.on("file-open", syncButtons));
		this.registerEvent(this.app.vault.on("modify", syncButtonsSoon));
		this.registerEvent(this.app.vault.on("rename", syncButtons));

		const refreshCompileSoon = debounce(() => this.compileButton.refresh(), 800, true);
		this.registerEvent(this.app.workspace.on("layout-change", () => this.compileButton.attach()));
		this.registerEvent(this.app.workspace.on("file-open", refreshCompileSoon));
		for (const event of ["modify", "create", "delete", "rename"] as const) {
			this.registerEvent(this.app.vault.on(event as "modify", refreshCompileSoon));
		}
		// Commits made outside Obsidian show up when you come back to it.
		this.registerDomEvent(window, "focus", refreshCompileSoon);
	}

	onunload() {
		this.commitButtons.removeAll();
		this.compileButton.detach();
		this.overlay.removeAll();
		this.noteStatus.removeAll();
		this.hiddenFolders.detach();
		this.compileRun?.cancel();
	}

	isCompiling(): boolean {
		return this.compileRun !== null;
	}

	/** Compiles every revision committed since the last compile. */
	async compile() {
		if (this.compileRun) {
			new Notice("A compile is already running.");
			await this.showReportView();
			return;
		}
		let vaultPath: string;
		let author: string;
		try {
			vaultPath = this.getVaultPath();
			if (!this.isVaultSetUp()) {
				new Notice("Set up the vault before compiling.");
				return;
			}
			const uncommitted = await changedFiles(vaultPath);
			if (uncommitted.length > 0) {
				const count = uncommitted.length;
				new Notice(`${count} uncommitted ${count === 1 ? "file isn't" : "files aren't"} part of this compile.`);
			}
			author = await authorName(vaultPath, this.settings);
		} catch (error) {
			new Notice(`Compile failed: ${errorMessage(error)}`, 10000);
			return;
		}

		const { projectFolder, claudeCommand, permissionMode, allowedTools, model, effort } = this.settings;
		let run: CompileRun;
		try {
			run = await startCompile(
				{
					vaultPath,
					projectFolder,
					claudeCommand,
					permissionMode,
					allowedTools,
					model,
					effort,
					author,
					onPermissionRequest: (request) => {
						new Notice(`Claude is asking to use ${request.tool}. Answer in the compile report.`);
						this.showReportView();
					},
				},
				() => {
					this.refreshReportViews();
					this.compileButton.render();
				},
			);
		} catch (error) {
			new Notice(
				error instanceof NothingToCompileError ? error.message : `Compile failed: ${errorMessage(error)}`,
				error instanceof NothingToCompileError ? 4000 : 10000,
			);
			return;
		}

		this.compileRun = run;
		this.reports = [run.report, ...this.reports].slice(0, MAX_REPORTS);
		this.statusBar?.setText("Compiling…");
		this.statusBar?.show();
		this.compileButton.refresh();
		this.noteStatus.sync();
		await this.saveSettings();
		await this.showReportView();
		for (const view of this.reportViews()) view.showLatest();

		const report = await run.done;
		this.compileRun = null;
		this.statusBar?.hide();
		await this.saveSettings();
		this.refreshReportViews();
		this.compileButton.refresh();
		this.overlay.sync();
		this.noteStatus.sync();
		const questions = report.questions.length;
		const extra = questions > 0 ? ` Claude has ${questions} question${questions === 1 ? "" : "s"} about the model.` : "";
		if (report.status === "succeeded") new Notice(`Compile finished.${extra}`);
		else if (report.status === "failed") new Notice(`Compile failed. See the compile report.${extra}`, 10000);
	}

	cancelCompile() {
		this.compileRun?.cancel();
	}

	/** Permission requests from the running compile that are waiting for an answer. */
	permissionRequests(): PermissionRequest[] {
		return this.compileRun?.requests ?? [];
	}

	/** Answers one permission request. Always allow also adds its rule to Allowed commands. */
	async answerPermission(id: string, answer: PermissionAnswer) {
		const request = this.compileRun?.requests.find((r) => r.id === id);
		if (!request) return;
		this.compileRun?.answer(id, answer);
		if (answer !== "always" || !request.rule) return;
		const rules = this.settings.allowedTools.trim();
		// One rule at the end of the list, never twice.
		if (!` ${rules} `.includes(` ${request.rule} `)) {
			this.settings.allowedTools = rules ? `${rules} ${request.rule}` : request.rule;
		}
		await this.saveSettings();
	}

	/** Opens theory.md's tab in Obsidian settings. */
	openSettings() {
		// `setting` isn't in Obsidian's public types, but it's the only way to open a plugin's tab.
		const setting = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
		setting.open();
		setting.openTabById(this.manifest.id);
	}

	/** Opens the compile report in a main tab, reusing it if it's already open. */
	async showReportView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(REPORT_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: REPORT_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	/** Opens the compile report on the latest compile, scrolled to any waiting permission card. */
	async showLatestReport() {
		await this.showReportView();
		for (const view of this.reportViews()) view.showLatest();
	}

	/** Opens the compile report on one past compile. */
	async showReport(id: string) {
		await this.showReportView();
		for (const view of this.reportViews()) view.show(id);
	}

	private reportViews(): CompileReportView[] {
		return this.app.workspace
			.getLeavesOfType(REPORT_VIEW_TYPE)
			.map((leaf) => leaf.view)
			.filter((view): view is CompileReportView => view instanceof CompileReportView);
	}

	/** Redraws everything that shows the reports: the report tab and the compile history. */
	refreshReportViews() {
		for (const view of this.reportViews()) view.refresh();
		for (const leaf of this.app.workspace.getLeavesOfType(COMPILE_HISTORY_VIEW_TYPE)) {
			if (leaf.view instanceof CompileHistoryView) leaf.view.refresh();
		}
	}

	async openCommitModal(file: TFile | null) {
		if (!file) {
			new Notice("Open a note to commit it.");
			return;
		}
		try {
			const changed = await changedFiles(this.getVaultPath());
			if (!changed.includes(file.path)) {
				new Notice("No changes to commit in this note.");
				return;
			}
			const others = changed.filter((path) => path !== file.path);
			new CommitModal(this.app, this, file, others).open();
		} catch (error) {
			new Notice(`Couldn't read changes: ${errorMessage(error)}`, 10000);
		}
	}

	/** Opens the commit modal for every changed file in the vault. */
	async openCommitAllModal() {
		try {
			const changed = await changedFiles(this.getVaultPath());
			if (changed.length === 0) {
				new Notice("No changes to commit.");
				return;
			}
			new CommitModal(this.app, this, null, changed).open();
		} catch (error) {
			new Notice(`Couldn't read changes: ${errorMessage(error)}`, 10000);
		}
	}

	/** Returns true when the commit was made. */
	async commitChanges(message: string, paths: string[] | "all"): Promise<boolean> {
		try {
			const hash = await commit(this.getVaultPath(), this.settings, message, paths);
			new Notice(`Committed ${hash}`);
			this.refreshGitState();
			return true;
		} catch (error) {
			new Notice(`Commit failed: ${errorMessage(error)}`, 10000);
			return false;
		}
	}

	/** Asks Claude for a commit message describing the changes to `paths`. Returns null when it couldn't. */
	async generateCommitMessage(paths: string[]): Promise<string | null> {
		try {
			return await generateCommitMessage(this.getVaultPath(), paths, this.settings.claudeCommand);
		} catch (error) {
			new Notice(`Couldn't generate a message: ${errorMessage(error)}`, 10000);
			return null;
		}
	}

	/** Opens the vault's root Index.md, reusing its tab if it's already open. */
	async openIndex() {
		const { vault, workspace } = this.app;
		const index = vault
			.getRoot()
			.children.find((child) => child instanceof TFile && child.name.toLowerCase() === "index.md");
		if (!(index instanceof TFile)) return;

		const existing = workspace
			.getLeavesOfType("markdown")
			.find((leaf) => leaf.view instanceof MarkdownView && leaf.view.file === index);
		if (existing) {
			workspace.setActiveLeaf(existing, { focus: true });
		} else {
			await workspace.getLeaf(false).openFile(index);
		}
	}

	/** Opens Index.md, waiting for Obsidian to notice it when setup has only just written it. */
	private openIndexWhenReady() {
		const isIndex = (file: TAbstractFile) => file.parent?.isRoot() === true && file.name.toLowerCase() === "index.md";
		if (this.app.vault.getRoot().children.some(isIndex)) {
			this.openIndex();
			return;
		}
		const ref = this.app.vault.on("create", (file) => {
			if (!isIndex(file)) return;
			this.app.vault.offref(ref);
			this.openIndex();
		});
		this.registerEvent(ref);
	}

	/** Adds the commit history tab to the right sidebar if it isn't there yet. */
	async showHistoryView(reveal: boolean) {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(HISTORY_VIEW_TYPE)[0];
		if (!leaf) {
			const right = workspace.getRightLeaf(false);
			if (!right) return;
			await right.setViewState({ type: HISTORY_VIEW_TYPE, active: false });
			leaf = right;
		}
		if (reveal) await workspace.revealLeaf(leaf);
	}

	/** Adds the compile history tab to the right sidebar, beside the commit history, if it isn't there yet. */
	private async showCompileHistoryView() {
		const { workspace } = this.app;
		if (workspace.getLeavesOfType(COMPILE_HISTORY_VIEW_TYPE).length > 0) return;
		const right = workspace.getRightLeaf(false);
		if (!right) return;
		await right.setViewState({ type: COMPILE_HISTORY_VIEW_TYPE, active: false });
	}

	/** Updates everything that shows git state after the repository changes. */
	refreshGitState() {
		this.commitButtons.sync();
		this.compileButton.refresh();
		this.noteStatus.sync();
		for (const leaf of this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE)) {
			if (leaf.view instanceof CommitHistoryView) leaf.view.refresh();
		}
	}

	async loadSettings() {
		const { reports, codeRepoPath, repos, ...settings } = (await this.loadData()) ?? {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, settings);
		// Earlier versions called the project folder the code repository, and briefly kept a list of repos.
		if (!this.settings.projectFolder && typeof codeRepoPath === "string") this.settings.projectFolder = codeRepoPath;
		this.reports = Array.isArray(reports) ? reports : [];
		for (const report of this.reports) {
			// Earlier versions kept problems as plain strings.
			report.problems = report.problems.map((problem) =>
				typeof problem === "string" ? plainProblem(problem) : problem,
			);
			// A compile can't outlive the app, so a report still running was cut short.
			if (report.status !== "running") continue;
			report.status = "failed";
			report.problems.unshift(plainProblem("Obsidian closed before this compile finished."));
		}
	}

	/** Saves the settings together with the compile reports. */
	async saveSettings() {
		await this.saveData({ ...this.settings, reports: this.reports });
		this.compileButton.refresh();
	}

	getVaultPath(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error("Setup vault is only available on desktop.");
		}
		return adapter.getBasePath();
	}

	isVaultSetUp(): boolean {
		return isVaultSetUp(this.getVaultPath());
	}

	/** Returns true when the vault ends up as a git repository. */
	async setUpVault(): Promise<boolean> {
		try {
			if (this.isVaultSetUp()) {
				new Notice("This vault is already set up.");
				return true;
			}
			await setUpVault(this.getVaultPath(), this.settings, starterFiles(this.app.vault.getName()));
			this.refreshGitState();
			new Notice("Vault set up as a git repository with an initial commit.");
			this.openIndexWhenReady();
			return true;
		} catch (error) {
			new Notice(`Setup vault failed: ${errorMessage(error)}`, 10000);
			return false;
		}
	}
}
