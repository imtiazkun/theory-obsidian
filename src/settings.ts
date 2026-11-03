import { App, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import { basename } from "path";
import type { CompileEffort, CompileModel, PermissionMode } from "./compile";
import { findProjectRepos, pickFolder } from "./project";
import type TheoryPlugin from "./main";

export interface AuthorSettings {
	fullName: string;
	email: string;
}

export interface TheorySettings extends AuthorSettings {
	/** Folder holding the project's code. Compile runs Claude Code here. */
	projectFolder: string;
	claudeCommand: string;
	permissionMode: PermissionMode;
	allowedTools: string;
	/** Passed to Claude Code as `--model`, unless it's "" (Claude Code default). */
	model: CompileModel;
	/** Passed to Claude Code as `--effort`, unless it's "" (Claude Code default). */
	effort: CompileEffort;
	showCompileButton: boolean;
}

export const DEFAULT_SETTINGS: TheorySettings = {
	fullName: "",
	email: "",
	projectFolder: "",
	claudeCommand: "claude",
	permissionMode: "acceptEdits",
	allowedTools: "Bash(git *)",
	model: "",
	effort: "",
	showCompileButton: true,
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
	return EMAIL_PATTERN.test(email);
}

export class TheorySettingTab extends PluginSettingTab {
	plugin: TheoryPlugin;

	constructor(app: App, plugin: TheoryPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Author")
			.setDesc("Used to sign the revisions you make in this vault.")
			.setHeading();

		new Setting(containerEl)
			.setName("Full name")
			.setDesc("Your name as it should appear in signatures.")
			.addText((text) =>
				text
					.setPlaceholder("Jane Doe")
					.setValue(this.plugin.settings.fullName)
					.onChange(async (value) => {
						this.plugin.settings.fullName = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		const emailSetting = new Setting(containerEl)
			.setName("Email address")
			.setDesc("Contact address shown next to your name.");
		emailSetting.addText((text) => {
			text.inputEl.type = "email";
			text
				.setPlaceholder("jane@example.com")
				.setValue(this.plugin.settings.email)
				.onChange(async (value) => {
					const email = value.trim();
					const valid = email === "" || isValidEmail(email);
					text.inputEl.toggleClass("theory-invalid", !valid);
					emailSetting.setDesc(
						valid
							? "Contact address shown next to your name."
							: "This doesn't look like a valid email address.",
					);
					if (valid) {
						this.plugin.settings.email = email;
						await this.plugin.saveSettings();
					}
				});
		});

		new Setting(containerEl).setName("Vault").setHeading();

		this.displaySetup(containerEl.createDiv({ cls: "theory-setup" }));

		this.displayProject(containerEl.createDiv({ cls: "theory-project" }));

		new Setting(containerEl)
			.setName("Compile")
			.setDesc("Compile hands new revisions of the model to Claude Code, which updates the code to match.")
			.setHeading();

		new Setting(containerEl)
			.setName("Show compile button")
			.setDesc("A button at the bottom right of the editor that shows how many revisions are waiting to compile.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showCompileButton).onChange(async (value) => {
					this.plugin.settings.showCompileButton = value;
					await this.plugin.saveSettings();
				}),
			);


		new Setting(containerEl)
			.setName("Claude Code command")
			.setDesc("The Claude Code CLI, as a command name or an absolute path.")
			.addText((text) =>
				text
					.setPlaceholder("claude")
					.setValue(this.plugin.settings.claudeCommand)
					.onChange(async (value) => {
						this.plugin.settings.claudeCommand = value.trim() || DEFAULT_SETTINGS.claudeCommand;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Model")
			.setDesc("The Claude model that compiles. A change applies from the next compile.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("", "Claude Code default")
					.addOption("fable", "Fable")
					.addOption("opus", "Opus")
					.addOption("sonnet", "Sonnet")
					.addOption("haiku", "Haiku")
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value as CompileModel;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Effort")
			.setDesc("How much Claude thinks while it compiles. A change applies from the next compile.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("", "Claude Code default")
					.addOption("low", "Low")
					.addOption("medium", "Medium")
					.addOption("high", "High")
					.addOption("xhigh", "Extra high")
					.addOption("max", "Max")
					.setValue(this.plugin.settings.effort)
					.onChange(async (value) => {
						this.plugin.settings.effort = value as CompileEffort;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Permission mode")
			.setDesc(
				"How much Claude may do without asking. Anything not allowed shows up in the compile report for you to allow or deny. Unanswered requests are denied after 120 seconds.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("acceptEdits", "Edit files, run only allowed commands")
					.addOption("auto", "Auto: Claude decides what is safe")
					.addOption("bypassPermissions", "Run anything (no checks)")
					.setValue(this.plugin.settings.permissionMode)
					.onChange(async (value) => {
						this.plugin.settings.permissionMode = value as PermissionMode;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Allowed commands")
			.setDesc(
				"Claude Code permission rules, separated by spaces, for the commands Claude may run, e.g. Bash(npm run *). Always allow on a permission card adds the request's rules here: every rule Claude Code suggests for a command (else the exact command), the exact file for a file tool. Writes to the model are always denied.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Bash(git *) Bash(npm run *)")
					.setValue(this.plugin.settings.allowedTools)
					.onChange(async (value) => {
						this.plugin.settings.allowedTools = value.trim();
						await this.plugin.saveSettings();
					}),
			);
	}

	/** The Setup vault button. A set-up vault missing starter files gets Create missing files, with the list. */
	private displaySetup(containerEl: HTMLElement) {
		containerEl.empty();
		if (!this.plugin.isVaultSetUp()) {
			new Setting(containerEl)
				.setName("Setup vault")
				.setDesc("Turn this vault into a git repository and make the initial commit.")
				.addButton((button) =>
					button
						.setButtonText("Setup vault")
						.setCta()
						.onClick(async () => {
							button.setDisabled(true).setButtonText("Setting up…");
							await this.plugin.setUpVault();
							this.display();
						}),
				);
			return;
		}

		// Checked each time the tab opens and after the button runs. Nothing is stored.
		const setting = new Setting(containerEl)
			.setName("Setup vault")
			.setDesc("This vault is already a git repository.")
			.addButton((button) => button.setButtonText("Already set up").setDisabled(true));
		this.plugin
			.missingStarters()
			.then((missing) => {
				const count = missing.files.length + missing.gitignoreLines.length;
				if (count === 0) return;
				setting.setDesc("This vault is a git repository, but some starter files are missing.");
				setting.controlEl.empty();
				setting.addButton((button) =>
					button
						.setButtonText("Create missing files")
						.setCta()
						.onClick(async () => {
							button.setDisabled(true).setButtonText("Creating…");
							await this.plugin.addMissingStarterFiles();
							this.displaySetup(containerEl);
						}),
				);
				const list = containerEl.createEl("ul", { cls: "theory-missing-starters" });
				for (const file of missing.files) list.createEl("li", { text: file.path });
				for (const line of missing.gitignoreLines) list.createEl("li", { text: `.gitignore line: ${line}` });
			})
			.catch(() => {
				// The check is only a hint; the button stays "Already set up" when it can't run.
			});
	}

	/** The project folder, with the git repositories found in it. */
	private displayProject(containerEl: HTMLElement) {
		containerEl.empty();
		const folder = this.plugin.settings.projectFolder;

		const setting = new Setting(containerEl).setName("Project folder");
		if (folder) {
			setting.descEl.createDiv({ cls: "theory-project-path", text: folder });
		} else {
			setting.setDesc("The folder holding this project's code. Compile runs Claude Code here.");
		}
		if (folder) {
			setting.addExtraButton((button) =>
				button
					.setIcon("refresh-cw")
					.setTooltip("Look for repositories again")
					.onClick(() => this.displayProject(containerEl)),
			);
		}
		setting.addButton((button) => {
			button.setButtonText(folder ? "Change…" : "Browse…");
			if (!folder) button.setCta();
			button.onClick(async () => {
				try {
					const picked = await pickFolder(folder);
					if (!picked) return;
					this.plugin.settings.projectFolder = picked;
					await this.plugin.saveSettings();
					this.displayProject(containerEl);
				} catch (error) {
					new Notice(error instanceof Error ? error.message : String(error));
				}
			});
		});
		if (!folder) return;

		const found = findProjectRepos(folder);
		if (found.kind === "missing" || found.kind === "none") {
			const warning = containerEl.createDiv({ cls: "theory-project-warning" });
			setIcon(warning.createSpan({ cls: "theory-project-warning-icon" }), "alert-triangle");
			warning.createSpan({
				text:
					found.kind === "missing"
						? "This folder doesn't exist anymore. Choose the project folder again."
						: "No git repositories found in the project folder.",
			});
			return;
		}

		const list = containerEl.createDiv({ cls: "theory-project-repos" });
		list.createDiv({
			cls: "theory-project-repos-title",
			text: found.kind === "root" ? "Project repository" : `Project repositories (${found.repos.length})`,
		});
		for (const repo of found.repos) {
			const row = list.createDiv({ cls: "theory-project-repo" });
			setIcon(row.createSpan({ cls: "theory-project-repo-icon" }), "git-branch");
			row.createSpan({ cls: "theory-project-repo-name", text: basename(repo) });
			row.setAttr("title", repo);
		}
	}
}
