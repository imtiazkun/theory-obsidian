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
	rulesToSave,
	withAllowedRules,
} from "./compile";
import { CompileReportView, REPORT_VIEW_TYPE } from "./report-view";
import { DEFAULT_SETTINGS, TheorySettingTab, TheorySettings } from "./settings";
import { CommitHistoryView, HISTORY_VIEW_TYPE } from "./history-view";
import { plainProblem } from "./anchor";
import { FailureOverlay } from "./overlay";
import { NoteStatus } from "./note-status";
import { EntryFiles, HiddenFolders } from "./explorer";
import { CREATE_PR_VIEW_TYPE, CreatePullRequestView } from "./create-pr-view";
import { pullRequestState } from "./github";
import { ExpandRun, startExpand } from "./expand";
import { EXPAND_VIEW_TYPE, ExpandView } from "./expand-view";
import { projectRepos } from "./branches";
import { PullRequestStates, RefreshReason } from "./pr-states";
import { PULL_INTERVALS, PullOutcome, PullReason, Puller, compileGate, pulledNotice } from "./pull";
import { REPOSITORIES_VIEW_TYPE, RepositoriesView } from "./repositories-view";
import { starterFiles } from "./starter";
import { loadToolPath } from "./tool-path";
import {
	MissingStarters,
	addMissingStarterFiles,
	authorName,
	changedFiles,
	commit,
	git,
	isVaultSetUp,
	missingStarters,
	setUpVault,
} from "./vault";

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
	private entryFiles = new EntryFiles(this);
	// Single user for now, so the compile lock only has to hold within this app.
	private compileRun: CompileRun | null = null;
	// True from the click until the compile runs or fails to start, so a second click can't start another.
	private compileStarting = false;
	// At most one Expand per repository at a time, keyed by its name.
	private expandRuns = new Map<string, ExpandRun>();
	private statusBar: HTMLElement | null = null;
	private pullRequestStates = new PullRequestStates({
		reports: () => this.reports,
		check: (pr) => pullRequestState(pr.repoPath, pr.url),
		changed: async () => {
			await this.saveSettings();
			this.pullRequestsChanged();
		},
	});

	puller = new Puller({
		vaultPath: () => {
			try {
				return this.isVaultSetUp() ? this.getVaultPath() : null;
			} catch {
				return null;
			}
		},
		projectFolder: () => this.settings.projectFolder,
		automatic: () => this.settings.pullAutomatically,
		pullCode: () => this.settings.pullCodeRepos,
		ownEmail: () => this.ownEmail(),
		compiling: () => this.isCompiling(),
		changed: () => this.compileButton.render(),
		pulled: (outcome, reason) => this.pulled(outcome, reason),
	});
	private pullTimer: number | null = null;
	// Set by scripts/install.sh on a first install: run Setup vault once, on the first load.
	private setupOnLoad = false;

	async onload() {
		// Obsidian opened from the Dock doesn't read the shell's startup files, so take the login shell's PATH.
		await loadToolPath();
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
		this.registerView(CREATE_PR_VIEW_TYPE, (leaf) => new CreatePullRequestView(leaf, this));
		this.registerView(EXPAND_VIEW_TYPE, (leaf) => new ExpandView(leaf, this));
		this.registerView(REPOSITORIES_VIEW_TYPE, (leaf) => new RepositoriesView(leaf, this));
		this.addCommand({
			id: "show-repositories",
			name: "Show repositories",
			callback: () => this.showRepositories(),
		});
		this.addRibbonIcon("folder-git-2", "Show repositories", () => this.showRepositories());
		this.addCommand({
			id: "pull-now",
			name: "Pull now",
			callback: () => this.pullNow(),
		});
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
			this.entryFiles.sync();
			if (this.setupOnLoad) await this.setUpOnFirstLoad();
			if (launching) this.puller.pull("launch");
			this.restartPullTimer();
		});
		// A file explorer opened later gets the same sorting and the same entry files.
		this.registerEvent(this.app.workspace.on("layout-change", () => this.hiddenFolders.attach()));
		const syncEntryFiles = debounce(() => this.entryFiles.sync(), 200, true);
		this.registerEvent(this.app.workspace.on("layout-change", syncEntryFiles));
		for (const event of ["create", "delete", "rename"] as const) {
			this.registerEvent(this.app.vault.on(event as "create", syncEntryFiles));
		}

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
		// The Expand button follows the active note at once.
		this.registerEvent(this.app.workspace.on("file-open", () => this.compileButton.render()));
		for (const event of ["modify", "create", "delete", "rename"] as const) {
			this.registerEvent(this.app.vault.on(event as "modify", refreshCompileSoon));
		}
		// Commits made outside Obsidian show up when you come back to it.
		this.registerDomEvent(window, "focus", refreshCompileSoon);
		// A pull request merged in the browser shows as merged on coming back. Never on a timer.
		this.registerDomEvent(window, "focus", () => this.refreshPullRequestStates("focus"));
		this.registerDomEvent(window, "focus", () => this.puller.pull("focus"));
	}

	/** Starts the pull timer again after its settings change (CFG-25, CFG-26). */
	restartPullTimer() {
		if (this.pullTimer !== null) window.clearInterval(this.pullTimer);
		this.pullTimer = null;
		if (!this.settings.pullAutomatically) return;
		this.pullTimer = window.setInterval(() => this.puller.pull("timer"), this.settings.pullInterval * 60_000);
	}

	/** Pulls at once, even when automatic pulls are off (PULL-11). */
	async pullNow() {
		if (this.isCompiling()) new Notice("A compile is running. The pull runs once it ends.");
		await this.puller.pull("now");
	}

	/** The email the engineer's own revisions are signed with: the settings', else git's. */
	private async ownEmail(): Promise<string> {
		if (this.settings.email) return this.settings.email;
		try {
			const { stdout } = await git(this.getVaultPath(), ["config", "--get", "user.email"]);
			return stdout.trim();
		} catch {
			return "";
		}
	}

	/** After a pull: names what changed in the vault (PULL-8) and redraws what shows git state. Code pulls stay silent. */
	private async pulled(outcome: PullOutcome, reason: PullReason) {
		if (outcome.vault?.kind === "pulled") {
			new Notice(pulledNotice(outcome.vault), 8000);
			this.refreshGitState();
			this.overlay.sync();
		} else if (reason === "now" && outcome.vault?.kind === "offline") {
			new Notice(`Couldn't pull: ${outcome.vault.message}`, 10000);
		}
		if (outcome.repos.some((repo) => repo.pulled) || reason === "now") {
			for (const leaf of this.app.workspace.getLeavesOfType(REPOSITORIES_VIEW_TYPE)) {
				if (leaf.view instanceof RepositoriesView) leaf.view.refresh(false);
			}
		}
	}

	onunload() {
		this.commitButtons.removeAll();
		this.compileButton.detach();
		this.overlay.removeAll();
		this.noteStatus.removeAll();
		this.hiddenFolders.detach();
		this.entryFiles.detach();
		this.compileRun?.cancel();
		for (const run of this.expandRuns.values()) run.cancel();
		if (this.pullTimer !== null) window.clearInterval(this.pullTimer);
	}

	isExpanding(repo: string): boolean {
		return this.expandRuns.has(repo);
	}

	private expandViews(repo: string): ExpandView[] {
		return this.app.workspace
			.getLeavesOfType(EXPAND_VIEW_TYPE)
			.map((leaf) => leaf.view)
			.filter((view): view is ExpandView => view instanceof ExpandView && view.repo === repo);
	}

	/** Opens the Expand view for the repository and asks Claude which notes its model folder is missing. */
	async expand(repo: string) {
		if (!repo) return;
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(EXPAND_VIEW_TYPE).find((l) => l.view instanceof ExpandView && l.view.repo === repo);
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: EXPAND_VIEW_TYPE, active: true, state: { repo } });
		}
		await workspace.revealLeaf(leaf);
		if (this.expandRuns.has(repo)) return;

		let vaultPath: string;
		try {
			vaultPath = this.getVaultPath();
		} catch (error) {
			for (const view of this.expandViews(repo)) view.showFailure(errorMessage(error));
			return;
		}
		const { claudeCommand, model, effort, projectFolder } = this.settings;
		const repoPath = projectRepos(projectFolder).find((r) => r.name === repo)?.path ?? null;
		const run = startExpand({ claudeCommand, model, effort, vaultPath, repo, repoPath });
		this.expandRuns.set(repo, run);
		for (const view of this.expandViews(repo)) view.running();
		this.compileButton.render();
		try {
			const suggestions = await run.done;
			for (const view of this.expandViews(repo)) view.showSuggestions(suggestions);
		} catch (error) {
			const reason = errorMessage(error);
			if (reason !== "cancelled") for (const view of this.expandViews(repo)) view.showFailure(reason);
		} finally {
			this.expandRuns.delete(repo);
			this.compileButton.render();
		}
	}

	/** Closing the last Expand view of a repository stops its run; its suggestions are discarded. */
	expandViewClosed(repo: string) {
		window.setTimeout(() => {
			if (this.expandViews(repo).length === 0) this.expandRuns.get(repo)?.cancel();
		}, 0);
	}

	isCompiling(): boolean {
		return this.compileRun !== null || this.compileStarting;
	}

	/** Compiles every revision committed since the last compile. */
	async compile() {
		if (this.isCompiling()) {
			new Notice("A compile is already running.");
			await this.showReportView();
			return;
		}
		this.compileStarting = true;
		try {
			await this.runCompile();
		} finally {
			this.compileStarting = false;
			this.compileRun = null;
			this.compileButton.refresh();
			// A pull that fell due during the compile runs now (PULL-4).
			this.puller.compileEnded();
		}
	}

	private async runCompile() {
		let vaultPath: string;
		let author: string;
		try {
			vaultPath = this.getVaultPath();
			// The newest model into the newest code, even when automatic pulls are off (PULL-15).
			const pull = await this.puller.pull("compile");
			const gate = compileGate(pull?.vault ?? null, pull?.repos ?? []);
			if (gate.error) {
				new Notice(`Compile failed: ${gate.error}`, 10000);
				return;
			}
			if (gate.offline) new Notice("Couldn't reach the remote, so this compile uses the local vault and code.", 8000);
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

		const { projectFolder, claudeCommand, agent, agentCommand, agentModel, agentThinkingLevel, permissionMode, allowedTools, model, effort } =
			this.settings;
		let run: CompileRun;
		try {
			run = await startCompile(
				{
					vaultPath,
					projectFolder,
					claudeCommand,
					agent,
					agentCommand,
					agentModel,
					agentThinkingLevel,
					permissionMode,
					allowedTools,
					model,
					effort,
					author,
					reports: this.reports,
					onPermissionRequest: (request) => {
						const who = request.sessionOnly ? "The agent" : "Claude";
						new Notice(`${who} is asking to use ${request.tool}. Answer in the compile report.`);
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
		this.compileStarting = false;
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
		this.pullRequestsChanged();
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

	/** Answers one permission request. Always allow on a Claude Code card also adds its rules to Allowed commands. */
	async answerPermission(id: string, answer: PermissionAnswer) {
		const request = this.compileRun?.requests.find((r) => r.id === id);
		if (!request) return;
		this.compileRun?.answer(id, answer);
		const rules = rulesToSave(request, answer);
		if (rules.length === 0) return;
		this.settings.allowedTools = withAllowedRules(this.settings.allowedTools, rules);
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

	/** Opens the Create PR page for one compile in a new tab. */
	async openCreatePullRequests(reportId: string) {
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: CREATE_PR_VIEW_TYPE, active: true, state: { reportId } });
		await this.app.workspace.revealLeaf(leaf);
	}

	/** Redraws everything that shows pull requests or compile branches, after they changed. */
	pullRequestsChanged() {
		for (const view of this.reportViews()) view.forgetPullRequests();
		this.refreshReportViews();
		for (const leaf of this.app.workspace.getLeavesOfType(REPOSITORIES_VIEW_TYPE)) {
			if (leaf.view instanceof RepositoriesView) leaf.view.refresh(false);
		}
	}

	/** Asks GitHub for the state of every draft and open pull request, and saves and redraws what changed. */
	refreshPullRequestStates(reason: RefreshReason): Promise<boolean> {
		return this.pullRequestStates.refresh(reason);
	}

	/** Opens the Repositories page in a main tab, reusing it if it's already open. */
	async showRepositories() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(REPOSITORIES_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: REPOSITORIES_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
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
		this.puller.recount();
		this.commitButtons.sync();
		this.compileButton.refresh();
		this.noteStatus.sync();
		for (const leaf of this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE)) {
			if (leaf.view instanceof CommitHistoryView) leaf.view.refresh();
		}
	}

	async loadSettings() {
		const { reports, codeRepoPath, repos, setupOnLoad, ...settings } = (await this.loadData()) ?? {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, settings);
		this.setupOnLoad = setupOnLoad === true;
		if (!(PULL_INTERVALS as readonly number[]).includes(this.settings.pullInterval)) this.settings.pullInterval = DEFAULT_SETTINGS.pullInterval;
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
		// The project folder decides which folders are model folders.
		this.entryFiles.sync();
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

	/**
	 * Sets up a freshly installed vault, once. The request is dropped from plugin data first, so a failed
	 * setup is never retried on its own; Setup vault in the command palette does that.
	 */
	private async setUpOnFirstLoad() {
		this.setupOnLoad = false;
		await this.saveSettings();
		if (!this.isVaultSetUp()) {
			await this.setUpVault();
			return;
		}
		// A vault that already has git is left as it is.
		const missing = await this.missingStarters();
		if (missing.files.length > 0 || missing.gitignoreLines.length > 0) {
			new Notice("theory.md is installed. This vault already uses git, so it was left as it is. Settings → theory.md can add the missing starter files.", 10000);
		}
	}

	/** The starter files and `.gitignore` lines this vault is missing. Worked out each time, never stored. */
	missingStarters(): Promise<MissingStarters> {
		return missingStarters(this.getVaultPath(), starterFiles(this.app.vault.getName()));
	}

	/** Writes the missing starter files and commits only them. */
	async addMissingStarterFiles(): Promise<void> {
		try {
			const added = await addMissingStarterFiles(this.getVaultPath(), this.settings, starterFiles(this.app.vault.getName()));
			this.refreshGitState();
			new Notice(`Added ${added} missing files.`);
		} catch (error) {
			new Notice(`Couldn't add the missing files: ${errorMessage(error)}`, 10000);
		}
	}
}
