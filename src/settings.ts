import { App, Modal, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import { basename } from "path";
import type { CompileAgent, CompileEffort, CompileModel, PermissionMode } from "./compile";
import { hasOrigin } from "./github";
import { findProjectRepos, pickFolder } from "./project";
import { PULL_INTERVALS, originUrl, remoteUrlProblem, saveOrigin } from "./pull";
import type TheoryPlugin from "./main";

export interface AuthorSettings {
	fullName: string;
	email: string;
}

export interface TheorySettings extends AuthorSettings {
	/** Folder holding the project's code. Compile runs Claude Code here. */
	projectFolder: string;
	claudeCommand: string;
	/** Which agent compiles. Expand, commit messages and pull request bodies always use Claude Code. */
	agent: CompileAgent;
	/** The command that starts the ACP agent, with its arguments. Empty by default. */
	agentCommand: string;
	/** The ACP agent's model, matched by value or name at compile. "" means the agent's default. Kept apart from `model` (AGT-24). */
	agentModel: string;
	/** The ACP agent's thinking level, matched by value or name at compile. "" means the agent's default. Kept apart from `effort`. */
	agentThinkingLevel: string;
	permissionMode: PermissionMode;
	allowedTools: string;
	/** Passed to Claude Code as `--model`, unless it's "" (Claude Code default). */
	model: CompileModel;
	/** Passed to Claude Code as `--effort`, unless it's "" (Claude Code default). */
	effort: CompileEffort;
	showCompileButton: boolean;
	/** Pull on launch, on focus and on the timer (CFG-25). */
	pullAutomatically: boolean;
	/** Minutes between timer pulls (CFG-26). */
	pullInterval: number;
	/** Each pull also pulls the code repositories (CFG-27). */
	pullCodeRepos: boolean;
}

export const DEFAULT_SETTINGS: TheorySettings = {
	fullName: "",
	email: "",
	projectFolder: "",
	claudeCommand: "claude",
	agent: "claude",
	agentCommand: "",
	agentModel: "",
	agentThinkingLevel: "",
	permissionMode: "acceptEdits",
	allowedTools: "Bash(git *)",
	model: "",
	effort: "",
	showCompileButton: true,
	pullAutomatically: true,
	pullInterval: 5,
	pullCodeRepos: true,
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
	return EMAIL_PATTERN.test(email);
}

/** The Compile heading's description, naming the agent that compiles (AGT-28). */
export function compileDescription(agent: CompileAgent): string {
	return agent === "acp"
		? "Compile hands new revisions of the model to the ACP agent, which updates the code to match."
		: "Compile hands new revisions of the model to Claude Code, which updates the code to match.";
}

/** The Claude Code command's description. With an ACP agent, Claude Code still runs everything but Compile (AGT-27). */
export function claudeCommandDescription(agent: CompileAgent): string {
	return agent === "acp"
		? "The Claude Code CLI, as a command name or an absolute path. Used for Expand, commit messages and pull request bodies."
		: "The Claude Code CLI, as a command name or an absolute path.";
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

		this.displayPull(containerEl.createDiv({ cls: "theory-pull-settings" }));

		new Setting(containerEl)
			.setName("Compile")
			.setDesc(compileDescription(this.plugin.settings.agent))
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
			.setName("Agent")
			.setDesc(
				"The agent that compiles. Claude Code, or any agent that speaks the Agent Client Protocol (ACP). Expand, commit messages and pull request bodies always use Claude Code.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("claude", "Claude Code")
					.addOption("acp", "ACP agent")
					.setValue(this.plugin.settings.agent)
					.onChange(async (value) => {
						this.plugin.settings.agent = value as CompileAgent;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (this.plugin.settings.agent === "acp") {
			new Setting(containerEl)
				.setName("Agent command")
				.setDesc(
					"The command that starts the agent, with its arguments. theory.md never installs an agent: install it yourself first.",
				)
				.addText((text) =>
					text
						.setPlaceholder("gemini --experimental-acp")
						.setValue(this.plugin.settings.agentCommand)
						.onChange(async (value) => {
							this.plugin.settings.agentCommand = value.trim();
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName("Claude Code command")
			.setDesc(claudeCommandDescription(this.plugin.settings.agent))
			.addText((text) =>
				text
					.setPlaceholder("claude")
					.setValue(this.plugin.settings.claudeCommand)
					.onChange(async (value) => {
						this.plugin.settings.claudeCommand = value.trim() || DEFAULT_SETTINGS.claudeCommand;
						await this.plugin.saveSettings();
					}),
			);

		// Settings never start the agent, not even to read its model list (AGT-25).
		if (this.plugin.settings.agent === "acp") this.displayAcpAgent(containerEl);
		else this.displayClaudeCode(containerEl);
	}

	/** Remote, Pull automatically, Check every and Also pull code repositories (CFG-25 to CFG-33). */
	private displayPull(containerEl: HTMLElement) {
		new Setting(containerEl)
			.setName("Pull")
			.setDesc("Keeps the vault and the code up to date with their remotes. Pulls only ever fast-forward.")
			.setHeading();
		const noRemote = containerEl.createDiv({ cls: "setting-item-description theory-pull-no-remote" });
		noRemote.setText("This vault has no remote, so its notes are never pulled. Add one below.");
		noRemote.hide();
		const setUp = this.plugin.isVaultSetUp();
		if (setUp) {
			hasOrigin(this.plugin.getVaultPath()).then((origin) => noRemote.toggle(!origin));
		} else {
			noRemote.show();
		}
		this.displayRemote(containerEl, setUp, noRemote);

		new Setting(containerEl)
			.setName("Pull automatically")
			.setDesc("Pull when Obsidian opens, when its window gets focus, and on a timer. Pull now and the pull before a compile always run.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.pullAutomatically).onChange(async (value) => {
					this.plugin.settings.pullAutomatically = value;
					await this.plugin.saveSettings();
					this.plugin.restartPullTimer();
				}),
			);

		new Setting(containerEl)
			.setName("Check every")
			.setDesc("How often the timer pulls.")
			.addDropdown((dropdown) => {
				for (const minutes of PULL_INTERVALS) dropdown.addOption(String(minutes), `${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
				dropdown.setValue(String(this.plugin.settings.pullInterval)).onChange(async (value) => {
					this.plugin.settings.pullInterval = Number(value);
					await this.plugin.saveSettings();
					this.plugin.restartPullTimer();
				});
			});

		new Setting(containerEl)
			.setName("Also pull code repositories")
			.setDesc("Each pull also fetches the repositories in the project folder, and fast-forwards those that are safe to.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.pullCodeRepos).onChange(async (value) => {
					this.plugin.settings.pullCodeRepos = value;
					await this.plugin.saveSettings();
				}),
			);
	}

	/** The vault's `origin`, which lives in its git config rather than the plugin's data (CFG-29 to CFG-33). */
	private displayRemote(containerEl: HTMLElement, setUp: boolean, noRemote: HTMLElement) {
		let value = "";
		const setting = new Setting(containerEl)
			.setName("Remote")
			.setDesc(setUp ? "The git URL the vault pulls from, its origin." : "Set up the vault first.")
			.addText((text) => {
				text.setPlaceholder("git@github.com:team/model.git").setDisabled(!setUp);
				text.inputEl.addClass("theory-remote-url");
				text.onChange((next) => (value = next.trim()));
				text.inputEl.addEventListener("keydown", (event) => {
					if (event.key === "Enter") save();
				});
				if (setUp) {
					originUrl(this.plugin.getVaultPath()).then((url) => {
						value = url ?? "";
						text.setValue(value);
					});
				}
			})
			.addButton((button) => button.setButtonText("Save").setDisabled(!setUp).onClick(() => save()));
		setting.settingEl.addClass("theory-remote-setting");

		const save = async () => {
			if (!setUp) return;
			const problem = remoteUrlProblem(value);
			if (problem) {
				new Notice(problem);
				return;
			}
			const vaultPath = this.plugin.getVaultPath();
			const current = await originUrl(vaultPath);
			if (current === value) return;
			if (current !== null && !(await confirmReplace(this.app, current, value))) return;
			try {
				await saveOrigin(vaultPath, value);
			} catch (error) {
				new Notice(`Couldn't save the remote: ${error instanceof Error ? error.message : String(error)}`, 10000);
				return;
			}
			noRemote.hide();
			new Notice("Remote saved. Pulling…");
			await this.plugin.puller.checkOrigin();
			await this.plugin.pullNow();
		};
	}

	/** Scrolls to the Remote setting, for "Add a remote…" in the sync menu (PULL-20). */
	revealRemote() {
		const field = this.containerEl.querySelector<HTMLElement>(".theory-remote-setting");
		field?.scrollIntoView({ block: "center" });
		field?.querySelector<HTMLInputElement>("input")?.focus();
	}

	/** Model and thinking level as text, matched against the agent's choices at compile (AGT-6, AGT-23). */
	private displayAcpAgent(containerEl: HTMLElement) {
		new Setting(containerEl)
			.setName("Agent model")
			.setDesc(
				"The model the agent compiles with, by its value or its name as the agent shows it. Empty means the agent's default. The activity log says which model the agent picked.",
			)
			.addText((text) =>
				text.setValue(this.plugin.settings.agentModel).onChange(async (value) => {
					this.plugin.settings.agentModel = value.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Agent thinking level")
			.setDesc(
				"How much the agent thinks while it compiles, by its value or its name as the agent shows it. Empty means the agent's default.",
			)
			.addText((text) =>
				text.setValue(this.plugin.settings.agentThinkingLevel).onChange(async (value) => {
					this.plugin.settings.agentThinkingLevel = value.trim();
					await this.plugin.saveSettings();
				}),
			);
	}

	/** Model, effort, permission mode and allowed commands: Claude Code only (AGT-7, AGT-26). */
	private displayClaudeCode(containerEl: HTMLElement) {
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
			setting.setDesc(
				`The folder holding this project's code. Compile runs ${this.plugin.settings.agent === "acp" ? "the ACP agent" : "Claude Code"} here.`,
			);
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

/** Asks before pointing the vault at a different remote (CFG-30). Resolves to true on a yes. */
function confirmReplace(app: App, from: string, to: string): Promise<boolean> {
	return new Promise((resolve) => {
		let answered = false;
		const modal = new Modal(app);
		modal.titleEl.setText("Replace the remote?");
		modal.contentEl.createEl("p", { text: `Replace the remote ${from} with ${to}? Pulls will come from the new remote.` });
		new Setting(modal.contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => modal.close()))
			.addButton((button) =>
				button
					.setButtonText("Replace")
					.setWarning()
					.onClick(() => {
						answered = true;
						modal.close();
					}),
			);
		modal.onClose = () => resolve(answered);
		modal.open();
	});
}
