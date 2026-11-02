import { App, ItemView, Modal, Notice, Setting, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { projectRepos } from "./branches";
import { timeAgo } from "./history-view";
import type TheoryPlugin from "./main";
import { findProjectRepos } from "./project";
import { PR_STATE_TEXT, STATUS_TEXT } from "./report-view";
import {
	NewRepository,
	RepoKpis,
	addModelFolder,
	createRepository,
	fetchAll,
	modelFolder,
	modelIndex,
	nameProblem,
	repoKpis,
} from "./repositories";

export const REPOSITORIES_VIEW_TYPE = "theory-repositories";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The Repositories page: one card per git repository in the project folder. */
export class RepositoriesView extends ItemView {
	plugin: TheoryPlugin;
	// Ignores results from an older draw that finishes after a newer one.
	private drawId = 0;

	constructor(leaf: WorkspaceLeaf, plugin: TheoryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return REPOSITORIES_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Repositories";
	}

	getIcon(): string {
		return "folder-git-2";
	}

	async onOpen() {
		this.addAction("refresh-cw", "Refresh: fetch every repository, then look again", () => this.refresh(true));
		await this.refresh(false);
	}

	/** Redraws the page. Only Refresh fetches, so opening the page is fast and works offline. */
	async refresh(fetch: boolean) {
		const id = ++this.drawId;
		const { contentEl } = this;
		contentEl.addClass("theory-repositories");
		const folder = this.plugin.settings.projectFolder;
		const found = findProjectRepos(folder);
		const repos = projectRepos(folder);

		if (fetch && repos.length > 0) {
			contentEl.empty();
			contentEl.createDiv({ cls: "theory-report-empty", text: "Fetching…" });
			const failed = await fetchAll(repos);
			if (failed.length > 0) new Notice(`Couldn't fetch ${failed.join(", ")}.`);
		}
		const kpis = await repoKpis(this.plugin, repos).catch((error) => {
			new Notice(`Couldn't read the repositories: ${errorMessage(error)}`, 10000);
			return [] as RepoKpis[];
		});
		if (id !== this.drawId) return;
		contentEl.empty();

		if (!folder) {
			contentEl.createDiv({ cls: "theory-report-empty", text: "Choose the project folder in theory.md settings first." });
			contentEl
				.createEl("button", { cls: "mod-cta", text: "Open settings" })
				.addEventListener("click", () => this.plugin.openSettings());
			return;
		}
		if (found.kind === "missing") {
			contentEl.createDiv({ cls: "theory-report-empty", text: `The project folder doesn't exist: ${folder}` });
			return;
		}

		const toolbar = contentEl.createDiv({ cls: "theory-report-toolbar" });
		const create = toolbar.createEl("button", { cls: "mod-cta", text: "New repository" });
		create.disabled = found.kind === "root";
		create.addEventListener("click", () => new NewRepositoryModal(this.app, this.plugin, () => this.refresh(false)).open());

		if (found.kind === "root") {
			contentEl.createDiv({
				cls: "theory-report-meta",
				text: "The project folder is a single repository. Choose a folder that holds repositories side by side to add more.",
			});
		}
		if (kpis.length === 0) {
			contentEl.createDiv({ cls: "theory-report-empty", text: "No repositories yet. Create one to start." });
			return;
		}
		const cards = contentEl.createDiv({ cls: "theory-repo-cards" });
		for (const kpi of kpis) this.card(cards, kpi);
	}

	private card(container: HTMLElement, kpi: RepoKpis) {
		const card = container.createDiv({ cls: "theory-repo-card" });
		const title = card.createDiv({ cls: "theory-repo-title" });
		setIcon(title.createSpan({ cls: "theory-repo-icon" }), "git-branch");
		const folder = modelFolder(this.plugin, kpi.name);
		const index = folder ? modelIndex(folder) : null;
		const name = title.createEl("a", { cls: "theory-repo-name", text: kpi.name, href: "#" });
		name.setAttr("title", index ? `Open ${index.path}` : kpi.path);
		name.addEventListener("click", (event) => {
			event.preventDefault();
			if (index) this.app.workspace.getLeaf(false).openFile(index);
			else new Notice(folder ? `${kpi.name}/ has no index.md.` : `${kpi.name} has no model folder.`);
		});

		const group = (label: string) => {
			const el = card.createDiv({ cls: "theory-repo-group" });
			el.createDiv({ cls: "theory-repo-group-title", text: label });
			return el.createDiv({ cls: "theory-repo-group-body" });
		};

		const code = group("Code");
		code.createDiv({ text: kpi.code.branch ? `On ${kpi.code.branch}` : "Not on a branch" });
		code.createDiv({
			text: kpi.code.lastCommit
				? `Last commit ${timeAgo(kpi.code.lastCommit.date)} by ${kpi.code.lastCommit.author}`
				: "No commits yet",
		});
		const n = kpi.code.uncommitted;
		code.createDiv({ text: n === 0 ? "No uncommitted changes" : `${n} ${n === 1 ? "file" : "files"} with uncommitted changes` });

		const compile = group("Compile");
		const last = kpi.compile.last;
		compile.createDiv({
			text: last ? `${STATUS_TEXT[last.status]} ${timeAgo(new Date(last.finishedAt ?? last.startedAt))}` : "Never compiled",
		});
		if (kpi.compile.openBranch) {
			const { branch, pr } = kpi.compile.openBranch;
			const row = compile.createDiv();
			row.createEl("code", { text: branch });
			row.appendText(" · Pull request: ");
			row.createSpan({ cls: `theory-pr-state is-${pr ?? "none"}`, text: pr ? PR_STATE_TEXT[pr] : "None" });
		}

		const model = group("Model");
		if (kpi.model) {
			const { notes, unrealized, waiting } = kpi.model;
			model.createDiv({ text: `${notes} ${notes === 1 ? "note" : "notes"}` });
			model.createDiv({ text: `${unrealized} not realized` });
			model.createDiv({ text: `${waiting} waiting for a compile` });
		} else {
			model.createDiv({ text: "No model folder" });
			const add = model.createEl("button", { text: "Add model folder" });
			add.addEventListener("click", async () => {
				add.disabled = true;
				try {
					await addModelFolder(this.plugin, kpi.name, `Manifesting ${kpi.name}\n`, `Add model folder for ${kpi.name}`);
					this.plugin.refreshGitState();
					new Notice(`Added the model folder ${kpi.name}/.`);
				} catch (error) {
					new Notice(`Couldn't add the model folder: ${errorMessage(error)}`, 10000);
				}
				await this.refresh(false);
			});
		}

		const remote = group("Remote");
		if (!kpi.remote) {
			remote.createDiv({ text: "No remote" });
		} else {
			if (kpi.remote.url) remote.createDiv().createEl("a", { text: kpi.remote.url.replace(/^https:\/\//, ""), href: kpi.remote.url });
			else remote.createDiv({ text: "origin isn't on GitHub" });
			remote.createDiv({
				text:
					kpi.remote.ahead === null
						? "This branch isn't on origin"
						: `${kpi.remote.ahead} ahead, ${kpi.remote.behind} behind origin`,
			});
		}
	}
}

/** The New repository form. Its text goes into the files exactly as typed. */
class NewRepositoryModal extends Modal {
	private form: NewRepository = {
		name: "",
		description: "",
		purpose: "",
		stack: "",
		build: "",
		test: "",
		run: "",
		conventions: "",
		github: false,
		visibility: "private",
	};

	constructor(
		app: App,
		private plugin: TheoryPlugin,
		private onCreated: () => void,
	) {
		super(app);
	}

	onOpen() {
		this.setTitle("New repository");
		this.render();
	}

	private render(steps: string[] = [], error: string | null = null) {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("theory-new-repo");
		const form = this.form;

		const nameSetting = new Setting(contentEl).setName("Name").setDesc("Lowercase letters, digits and dashes.");
		nameSetting.addText((text) =>
			text.setValue(form.name).onChange((value) => {
				form.name = value.trim();
				const problem = form.name ? nameProblem(this.plugin, form.name) : null;
				nameSetting.setDesc(problem ?? "Lowercase letters, digits and dashes.");
				text.inputEl.toggleClass("theory-invalid", problem !== null);
			}),
		);
		new Setting(contentEl)
			.setName("Description")
			.setDesc("One sentence.")
			.addText((text) => text.setValue(form.description).onChange((value) => (form.description = value)));
		this.area("Purpose", "What the repository does and why.", "purpose");
		new Setting(contentEl)
			.setName("Stack")
			.setDesc("Languages and frameworks.")
			.addText((text) => text.setPlaceholder("TypeScript, React").setValue(form.stack).onChange((value) => (form.stack = value)));
		for (const [key, label] of [
			["build", "Build command"],
			["test", "Test command"],
			["run", "Run command"],
		] as const) {
			new Setting(contentEl).setName(label).addText((text) => text.setValue(form[key]).onChange((value) => (form[key] = value)));
		}
		this.area("Conventions", "Rules for working in this repository.", "conventions");
		new Setting(contentEl).setName("Create GitHub repository").addToggle((toggle) =>
			toggle.setValue(form.github).onChange((value) => {
				form.github = value;
				this.render(steps, error);
			}),
		);
		if (form.github) {
			new Setting(contentEl).setName("Visibility").addDropdown((dropdown) =>
				dropdown
					.addOption("private", "Private")
					.addOption("public", "Public")
					.setValue(form.visibility)
					.onChange((value) => (form.visibility = value as NewRepository["visibility"])),
			);
		}

		if (error) {
			const failed = contentEl.createDiv({ cls: "theory-new-repo-error" });
			failed.createDiv({ text: `Couldn't create the repository: ${error}` });
			if (steps.length > 0) {
				failed.createDiv({ cls: "theory-report-meta", text: "Already done:" });
				const list = failed.createEl("ul");
				for (const step of steps) list.createEl("li", { text: step });
			}
		}

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		const create = buttons.createEl("button", { cls: "mod-cta", text: "Create" });
		create.addEventListener("click", () => this.create(create));
	}

	private area(name: string, desc: string, key: "purpose" | "conventions") {
		new Setting(this.contentEl)
			.setName(name)
			.setDesc(desc)
			.addTextArea((text) => {
				text.inputEl.rows = 4;
				text.setValue(this.form[key]).onChange((value) => (this.form[key] = value));
			});
	}

	private async create(button: HTMLButtonElement) {
		const form = this.form;
		if (!form.description.trim()) {
			new Notice("Write a one-sentence description first.");
			return;
		}
		button.disabled = true;
		button.setText("Creating…");
		const steps: string[] = [];
		try {
			await createRepository(this.plugin, form, (step) => steps.push(step));
		} catch (error) {
			// Nothing created is deleted: the engineer sees what is already done.
			this.render(steps, errorMessage(error));
			if (steps.length > 0) this.onCreated();
			return;
		}
		this.close();
		new Notice(`Created repository ${form.name}.`);
		this.plugin.refreshGitState();
		this.onCreated();
		const index = this.app.vault.getAbstractFileByPath(`${form.name}/index.md`);
		if (index instanceof TFile) await this.app.workspace.getLeaf(false).openFile(index);
	}
}
