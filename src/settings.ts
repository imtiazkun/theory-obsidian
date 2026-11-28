import { App, Modal, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import { basename } from "path";
import {
	SAME,
	TASK_NAMES,
	type BuildRow,
	type ClaudeRow,
	type CompileRow,
	type TaskRows,
	agentName,
	claudeCodeOnlyWrites,
	defaultTaskRows,
	resolveTask,
} from "./agent-rows";
import type { CompileAgent, CompileEffort, CompileModel, PermissionMode } from "./compile";
import { BUILT_IN_PRICES, PARTS, PART_NAMES, type ModelPrice, parsePrice } from "./costs";
import { hasOrigin } from "./github";
import { HOOK_EVENTS, HOOK_EVENT_NAMES, type Hook, type HookEvent } from "./hooks";
import { findProjectRepos, pickFolder } from "./project";
import { PULL_INTERVALS, originUrl, remoteUrlProblem, saveOrigin } from "./pull";
import { shareToggleQuestion } from "./shared-report";
import type TheoryPlugin from "./main";
import {
	GIT_MISSING,
	IDENTITY_COMMANDS,
	type SavedAuthor,
	gitIdentity,
	isVaultSetUp,
	missingIdentity,
	savedAuthorOffer,
	useSavedAuthor,
} from "./vault";

export interface TheorySettings extends SavedAuthor {
	/** Folder holding the project's code. Compile runs Claude Code here. */
	projectFolder: string;
	claudeCommand: string;
	/** One row per task: Compile, Check, Build, Expand and Writing, each with its agent, model and effort (CFG-41). */
	tasks: TaskRows;
	/** Run the question pass before a compile (CMP-105, CFG-47). On by default. */
	askQuestionsFirst: boolean;
	/** Prices that override the built-in ones, per million tokens (CFG-48). Empty by default. */
	modelPrices: ModelPrice[];
	permissionMode: PermissionMode;
	allowedTools: string;
	showCompileButton: boolean;
	/** Shows who last changed each rule in the editor (CFG-38). */
	showRuleAuthors: boolean;
	/** Pull on launch, on focus and on the timer (CFG-25). */
	pullAutomatically: boolean;
	/** Minutes between timer pulls (CFG-26). */
	pullInterval: number;
	/** Each pull also pulls the code repositories (CFG-27). */
	pullCodeRepos: boolean;
	/**
	 * Share compile reports in `.compiles/`, where they set the marker (CFG-44). Off: every report stays in the data
	 * file, and the marker is the local tag `theory/compiled`. On by default, whether or not the vault's repo is public.
	 */
	shareReports: boolean;
	/** Set once the one-time import of the old tag as a shared marker is done (CFG-45). Not shown in the settings. */
	markerImported: boolean;
	/** The engineer's own commands run on events (HOOK-1). In plugin data only, never in the vault (HOOK-8). */
	hooks: Hook[];
	/** The GitHub Project every issue a compile creates is added to, as its URL (CFG-40). Empty by default. */
	githubProject: string;
}

export const DEFAULT_SETTINGS: TheorySettings = {
	fullName: "",
	email: "",
	projectFolder: "",
	claudeCommand: "claude",
	tasks: defaultTaskRows(),
	askQuestionsFirst: true,
	modelPrices: [],
	permissionMode: "acceptEdits",
	allowedTools: "Bash(git *)",
	showCompileButton: true,
	showRuleAuthors: true,
	pullAutomatically: true,
	pullInterval: 5,
	pullCodeRepos: true,
	shareReports: true,
	markerImported: false,
	hooks: [],
	githubProject: "",
};

/** The Compile heading's description, naming the agent that compiles and the one that builds (AGT-28). */
export function compileDescription(rows: TaskRows): string {
	const compile = resolveTask(rows, "compile").agent;
	const build = resolveTask(rows, "build").agent;
	return `Compile hands new revisions of the model to ${agentName(compile)}, which plans the work as GitHub issues. Build has ${agentName(build)} write the code for each issue.`;
}

/** The Claude Code command's description. With an ACP agent for Compile, Check and Build, Claude Code still runs Expand and Writing (AGT-27). */
export function claudeCommandDescription(rows: TaskRows): string {
	return claudeCodeOnlyWrites(rows)
		? "The Claude Code CLI, as a command name or an absolute path. Used for Expand and Writing."
		: "The Claude Code CLI, as a command name or an absolute path.";
}

/** Permission mode and Allowed commands are hidden only when Build, after following Compile, runs an ACP agent (AGT-26). */
export function showsPermissionSettings(rows: TaskRows): boolean {
	return resolveTask(rows, "build").agent !== "acp";
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
			.setDesc("The name and email git signs this vault's commits with: the vault's own git config, else the global one.")
			.setHeading();
		this.displayAuthor(containerEl.createDiv({ cls: "theory-author" }));

		new Setting(containerEl).setName("Vault").setHeading();

		this.displaySetup(containerEl.createDiv({ cls: "theory-setup" }));

		this.displayProject(containerEl.createDiv({ cls: "theory-project" }));

		this.displayPull(containerEl.createDiv({ cls: "theory-pull-settings" }));

		new Setting(containerEl)
			.setName("Compile")
			.setDesc(compileDescription(this.plugin.settings.tasks))
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
			.setName("Show rule authors")
			.setDesc("Grey text after each rule's first line, saying who last changed it and when.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showRuleAuthors).onChange(async (value) => {
					this.plugin.settings.showRuleAuthors = value;
					await this.plugin.saveSettings();
					// Applies at once to every open note (CFG-38).
					this.plugin.ruleAuthors.sync();
				}),
			);


		this.displayTaskRows(containerEl);

		new Setting(containerEl)
			.setName("Claude Code command")
			.setDesc(claudeCommandDescription(this.plugin.settings.tasks))
			.addText((text) =>
				text
					.setPlaceholder("claude")
					.setValue(this.plugin.settings.claudeCommand)
					.onChange(async (value) => {
						this.plugin.settings.claudeCommand = value.trim() || DEFAULT_SETTINGS.claudeCommand;
						await this.plugin.saveSettings();
					}),
			);

		// Claude Code only, and only a build can use them (AGT-7, AGT-26).
		if (showsPermissionSettings(this.plugin.settings.tasks)) this.displayPermissions(containerEl);

		new Setting(containerEl).setName("GitHub Project").setHeading();
		new Setting(containerEl)
			.setName("GitHub Project")
			.setDesc(
				"Every issue a compile creates is added to this GitHub Project, given as its URL, like https://github.com/orgs/team/projects/1. Compile and Build don't start while it is empty.",
			)
			.addText((text) =>
				text
					.setPlaceholder("https://github.com/orgs/team/projects/1")
					.setValue(this.plugin.settings.githubProject)
					.onChange(async (value) => {
						this.plugin.settings.githubProject = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Hooks")
			.setDesc(
				"Your own shell commands, run after an event with the event as JSON on stdin, in the vault folder. Kept in plugin data, never in the vault, so they can hold secrets like a webhook URL.",
			)
			.setHeading();
		this.displayHooks(containerEl.createDiv({ cls: "theory-hooks" }));
	}

	/** The list of hooks, each with its event, its command and a Test button (HOOK-1, HOOK-9). */
	private displayHooks(containerEl: HTMLElement) {
		containerEl.empty();
		const hooks = this.plugin.settings.hooks;
		hooks.forEach((hook, index) => {
			new Setting(containerEl)
				.addDropdown((dropdown) => {
					for (const event of HOOK_EVENTS) dropdown.addOption(event, `${event}: ${HOOK_EVENT_NAMES[event]}`);
					dropdown.setValue(hook.event).onChange(async (value) => {
						hook.event = value as HookEvent;
						await this.plugin.saveSettings();
					});
				})
				.addText((text) =>
					text
						.setPlaceholder("curl -s -X POST -d @- https://…")
						.setValue(hook.command)
						.onChange(async (value) => {
							hook.command = value;
							await this.plugin.saveSettings();
						}),
				)
				.addButton((button) =>
					button.setButtonText("Test").onClick(async () => {
						if (!hook.command.trim()) {
							new Notice("Enter the hook's command first.");
							return;
						}
						button.setDisabled(true);
						const result = await this.plugin.hooks.test(hook);
						button.setDisabled(false);
						if (result.ok) new Notice(`Hook for ${hook.event} ran.`);
					}),
				)
				.addExtraButton((button) =>
					button
						.setIcon("trash")
						.setTooltip("Remove hook")
						.onClick(async () => {
							hooks.splice(index, 1);
							await this.plugin.saveSettings();
							this.displayHooks(containerEl);
						}),
				);
		});
		new Setting(containerEl).addButton((button) =>
			button.setButtonText("Add hook").onClick(async () => {
				hooks.push({ event: "commit", command: "" });
				await this.plugin.saveSettings();
				this.displayHooks(containerEl);
			}),
		);
	}

	/** The identity git signs with, read from git each time and never edited here (CFG-34 to CFG-37). */
	private async displayAuthor(containerEl: HTMLElement) {
		containerEl.empty();
		const basePath = this.plugin.getVaultPath();
		const identity = await gitIdentity(basePath);
		if (identity.kind === "no-git") {
			containerEl.createDiv({ cls: "setting-item-description theory-author-problem", text: GIT_MISSING });
			return;
		}
		// What git has is shown as plain text, never as a field (CFG-34, CFG-36).
		if (identity.name) new Setting(containerEl).setName("Name").setDesc(identity.name);
		if (identity.email) new Setting(containerEl).setName("Email").setDesc(identity.email);
		const missing = missingIdentity(identity);
		if (missing.length === 0) return;

		for (const key of missing) {
			containerEl.createDiv({
				cls: "setting-item-description theory-author-problem",
				text: `Git has no ${key} to sign your commits with. Set it in a terminal:`,
			});
			const command = IDENTITY_COMMANDS[key];
			const row = containerEl.createDiv({ cls: "theory-author-command" });
			row.createEl("code", { text: command });
			const copy = row.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Copy" } });
			setIcon(copy, "copy");
			copy.addEventListener("click", async () => {
				await navigator.clipboard.writeText(command);
				new Notice("Copied.");
			});
		}
		const actions = new Setting(containerEl).addButton((button) =>
			button.setButtonText("Check again").onClick(() => this.displayAuthor(containerEl)),
		);
		const offer = savedAuthorOffer(identity, this.plugin.settings);
		if (offer && isVaultSetUp(basePath)) {
			actions.addButton((button) =>
				button
					.setButtonText(`Use ${offer.name} <${offer.email}> for this vault`)
					.setCta()
					.onClick(async () => {
						try {
							await useSavedAuthor(basePath, offer);
						} catch (error) {
							new Notice(`Couldn't save the author: ${error instanceof Error ? error.message : String(error)}`, 10000);
						}
						this.displayAuthor(containerEl);
					}),
			);
		}
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

		// CFG-44: on by default. Turning it off asks first, and staying on puts the toggle back.
		new Setting(containerEl)
			.setName("Share compile reports")
			.setDesc(
				"Commit and push each compile's report in .compiles/, so teammates see why each issue exists and start from the same last compile. Off keeps every report on this machine, and the last compile is the local tag theory/compiled.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.shareReports).onChange(async (value) => {
					if (value === this.plugin.settings.shareReports) return;
					const question = shareToggleQuestion(value);
					if (question && !(await confirmChoice(this.app, "Share compile reports", question, "Turn off"))) {
						toggle.setValue(this.plugin.settings.shareReports);
						return;
					}
					this.plugin.settings.shareReports = value;
					await this.plugin.saveSettings();
					this.plugin.refreshGitState();
				}),
			);
	}

	/**
	 * The vault's `origin`, which lives in its git config rather than the plugin's data (CFG-29 to CFG-33).
	 * An existing `origin` is shown as plain text and only changed in git; Save only ever adds one.
	 */
	private displayRemote(containerEl: HTMLElement, setUp: boolean, noRemote: HTMLElement) {
		const setting = new Setting(containerEl).setName("Remote");
		setting.settingEl.addClass("theory-remote-setting");
		if (!setUp) {
			this.displayRemoteField(setting, false, noRemote);
			return;
		}
		originUrl(this.plugin.getVaultPath()).then((url) => {
			if (url === null) {
				this.displayRemoteField(setting, true, noRemote);
				return;
			}
			const desc = createFragment((fragment) => {
				fragment.createDiv({ cls: "theory-remote-current", text: url });
				const hint = fragment.createDiv();
				hint.appendText("To change it, run ");
				hint.createEl("code", { text: "git remote set-url origin <url>" });
				hint.appendText(" in the vault.");
			});
			setting.setDesc(desc);
		});
	}

	/** The empty field and Save button for a vault without an `origin` (CFG-29, CFG-30). */
	private displayRemoteField(setting: Setting, setUp: boolean, noRemote: HTMLElement) {
		let value = "";
		const save = async () => {
			if (!setUp) return;
			const problem = remoteUrlProblem(value);
			if (problem) {
				new Notice(problem);
				return;
			}
			let saved: "added" | "exists";
			try {
				saved = await saveOrigin(this.plugin.getVaultPath(), value);
			} catch (error) {
				new Notice(`Couldn't save the remote: ${error instanceof Error ? error.message : String(error)}`, 10000);
				return;
			}
			if (saved === "exists") {
				// Added in git since the settings opened: show it rather than replace it.
				this.display();
				return;
			}
			noRemote.hide();
			new Notice("Remote saved. Pulling…");
			await this.plugin.puller.checkOrigin();
			await this.plugin.pullNow();
			this.display();
		};
		setting
			.setDesc(setUp ? "The git URL the vault pulls from, its origin." : "Set up the vault first.")
			.addText((text) => {
				text.setPlaceholder("git@github.com:team/model.git").setDisabled(!setUp);
				text.inputEl.addClass("theory-remote-url");
				text.onChange((next) => (value = next.trim()));
				text.inputEl.addEventListener("keydown", (event) => {
					if (event.key === "Enter") save();
				});
			})
			.addButton((button) => button.setButtonText("Save").setDisabled(!setUp).onClick(() => save()));
	}

	/** Scrolls to the Remote setting, for "Add a remote…" in the sync menu (PULL-20). */
	revealRemote() {
		const field = this.containerEl.querySelector<HTMLElement>(".theory-remote-setting");
		field?.scrollIntoView({ block: "center" });
		field?.querySelector<HTMLInputElement>("input")?.focus();
	}

	/** One row per task, each with its agent, model and effort (CFG-41 to CFG-43, AGT-4 to AGT-6). Settings never start an agent (AGT-25). */
	private displayTaskRows(containerEl: HTMLElement) {
		const rows = this.plugin.settings.tasks;
		new Setting(containerEl)
			.setName("Agents and models")
			.setDesc(
				"Each task has its own agent, model and effort. Compile, Check and Build may use Claude Code or any agent that speaks the Agent Client Protocol (ACP). Expand and Writing (commit messages, pull request bodies and suggestions) always use Claude Code. A change applies from the task's next run.",
			)
			.setHeading();
		this.displayCompileRow(containerEl, rows.compile);
		this.displayFollowingRow(containerEl, rows, "check", "Asks about the model before a compile reads the code.");
		this.displayFollowingRow(containerEl, rows, "build", "Writes the code for each issue.");
		this.displayClaudeRow(containerEl, rows.expand, "Expand", "Suggests notes a model folder is missing.");
		this.displayClaudeRow(containerEl, rows.writing, "Writing", "Commit messages, pull request bodies and suggestions.");

		// CFG-47: on by default. The question pass itself reads this when a compile starts (CMP-105).
		new Setting(containerEl)
			.setName("Ask questions first")
			.setDesc(
				"Before a compile reads the code, the Check row reads only the model and asks what it leaves unclear. A question found this way costs far less than a recompile.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.askQuestionsFirst).onChange(async (value) => {
					this.plugin.settings.askQuestionsFirst = value;
					await this.plugin.saveSettings();
				}),
			);

		this.displayModelPrices(containerEl.createDiv({ cls: "theory-model-prices" }));
	}

	/**
	 * Model prices (CFG-48): a model name with its price per million tokens for each part. A model listed here uses
	 * these prices instead of the built-in ones, in every report shown afterwards, old ones included (REP-57).
	 */
	private displayModelPrices(containerEl: HTMLElement) {
		containerEl.empty();
		const prices = this.plugin.settings.modelPrices;
		new Setting(containerEl)
			.setName("Model prices")
			.setDesc(
				"US dollars per million tokens, for input, output, cache writes and cache reads. Reports estimate costs from the built-in prices; a model listed here uses your prices instead, in every report, old ones too. Name the model as Claude Code does, like claude-opus-5-5.",
			)
			.addButton((button) =>
				button.setButtonText("Add model").onClick(async () => {
					prices.push({ model: "", input: 0, output: 0, cacheWrites: 0, cacheReads: 0 });
					await this.plugin.saveSettings();
					this.displayModelPrices(containerEl);
				}),
			);
		prices.forEach((price, index) => {
			const row = new Setting(containerEl).setClass("theory-model-price");
			row.addText((text) => {
				text.setPlaceholder("claude-opus-5-5").setValue(price.model);
				text.inputEl.setAttr("aria-label", "Model");
				text.onChange(async (value) => {
					price.model = value.trim();
					await this.plugin.saveSettings();
				});
			});
			for (const part of PARTS) {
				row.addText((text) => {
					text.setPlaceholder(PART_NAMES[part]).setValue(String(price[part]));
					text.inputEl.setAttr("aria-label", `${PART_NAMES[part]}, dollars per million tokens`);
					text.inputEl.setAttr("title", PART_NAMES[part]);
					text.inputEl.addClass("theory-model-price-number");
					text.onChange(async (value) => {
						const parsed = parsePrice(value);
						text.inputEl.toggleClass("theory-invalid", parsed === null);
						if (parsed === null) return;
						price[part] = parsed;
						await this.plugin.saveSettings();
					});
				});
			}
			row.addExtraButton((button) =>
				button
					.setIcon("trash-2")
					.setTooltip("Remove this price")
					.onClick(async () => {
						prices.splice(index, 1);
						await this.plugin.saveSettings();
						this.displayModelPrices(containerEl);
					}),
			);
		});
		const builtIn = containerEl.createEl("details", { cls: "theory-built-in-prices" });
		builtIn.createEl("summary", { text: "Built-in prices" });
		const list = builtIn.createEl("ul");
		for (const p of BUILT_IN_PRICES) {
			list.createEl("li", { text: `${p.model}: ${PARTS.map((part) => `${PART_NAMES[part].toLowerCase()} $${p[part]}`).join(", ")}` });
		}
	}

	private rowTitle(containerEl: HTMLElement, name: string, desc: string) {
		const title = new Setting(containerEl).setName(name).setDesc(desc);
		title.settingEl.addClass("theory-task-row");
	}

	private displayCompileRow(containerEl: HTMLElement, row: CompileRow) {
		this.rowTitle(containerEl, TASK_NAMES.compile, `Plans the work as GitHub issues. Runs ${agentName(row.agent)}.`);
		this.agentDropdown(containerEl, row.agent, false, async (value) => {
			row.agent = value as CompileAgent;
		});
		if (row.agent === "acp") this.displayAcpFields(containerEl, row, "compile");
		else this.modelAndEffort(containerEl, row, false);
	}

	/** Check's and Build's rows: Same as Compile by default, and either may use an ACP agent (CFG-42, CFG-43, CFG-46). */
	private displayFollowingRow(containerEl: HTMLElement, rows: TaskRows, task: "check" | "build", what: string) {
		const row: BuildRow = rows[task];
		const agent = resolveTask(rows, task).agent;
		const desc = row.agent === SAME ? `${what} Same as Compile: runs ${agentName(agent)}.` : `${what} Runs ${agentName(agent)}.`;
		this.rowTitle(containerEl, TASK_NAMES[task], desc);
		this.agentDropdown(containerEl, row.agent, true, async (value) => {
			row.agent = value as BuildRow["agent"];
		});
		if (row.agent === SAME) return;
		if (row.agent === "acp") this.displayAcpFields(containerEl, row, task);
		else this.modelAndEffort(containerEl, row, true);
	}

	/** Expand and Writing always run Claude Code, with their own model and effort (CFG-43). */
	private displayClaudeRow(containerEl: HTMLElement, row: ClaudeRow, name: string, what: string) {
		this.rowTitle(containerEl, name, `${what} Runs Claude Code.`);
		this.modelAndEffort(containerEl, row, true);
	}

	/** Agent is a dropdown in the Compile, Check and Build rows; Check's and Build's also offer "Same as Compile" (AGT-4, CFG-46). */
	private agentDropdown(containerEl: HTMLElement, value: string, same: boolean, set: (value: string) => Promise<void>) {
		new Setting(containerEl).setName("Agent").addDropdown((dropdown) => {
			if (same) dropdown.addOption(SAME, "Same as Compile");
			dropdown
				.addOption("claude", "Claude Code")
				.addOption("acp", "ACP agent")
				.setValue(value)
				.onChange(async (next) => {
					await set(next);
					await this.plugin.saveSettings();
					this.display();
				});
		});
	}

	/** An ACP row's command, model and thinking level, stored apart from its Claude Code model and effort (AGT-5, AGT-6, AGT-24). */
	private displayAcpFields(
		containerEl: HTMLElement,
		row: { agentCommand: string; agentModel: string; agentThinkingLevel: string },
		task: "compile" | "check" | "build",
	) {
		const doing = task === "check" ? "check the model" : task;
		new Setting(containerEl)
			.setName("Agent command")
			.setDesc(
				`The command that starts the agent, with its arguments. theory.md never installs an agent: install it yourself first. ${TASK_NAMES[task]} can't start while it is empty.`,
			)
			.addText((text) =>
				text
					.setPlaceholder("gemini --experimental-acp")
					.setValue(row.agentCommand)
					.onChange(async (value) => {
						row.agentCommand = value.trim();
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName("Agent model")
			.setDesc(
				`The model the agent uses to ${doing}, by its value or its name as the agent shows it. Empty means the agent's default. The activity log says which model the agent picked.`,
			)
			.addText((text) =>
				text.setValue(row.agentModel).onChange(async (value) => {
					row.agentModel = value.trim();
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("Agent thinking level")
			.setDesc("How much the agent thinks, by its value or its name as the agent shows it. Empty means the agent's default.")
			.addText((text) =>
				text.setValue(row.agentThinkingLevel).onChange(async (value) => {
					row.agentThinkingLevel = value.trim();
					await this.plugin.saveSettings();
				}),
			);
	}

	/** A row's Claude Code Model and Effort (CFG-17, CFG-18). Rows other than Compile also offer "Same as Compile". */
	private modelAndEffort(
		containerEl: HTMLElement,
		row: { model: CompileModel | typeof SAME; effort: CompileEffort | typeof SAME },
		same: boolean,
	) {
		new Setting(containerEl)
			.setName("Model")
			.setDesc("The Claude model this task runs with.")
			.addDropdown((dropdown) => {
				if (same) dropdown.addOption(SAME, "Same as Compile");
				dropdown
					.addOption("", "Claude Code default")
					.addOption("fable", "Fable")
					.addOption("opus", "Opus")
					.addOption("sonnet", "Sonnet")
					.addOption("haiku", "Haiku")
					.setValue(row.model)
					.onChange(async (value) => {
						row.model = value as CompileModel;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Effort")
			.setDesc("How much Claude thinks during this task.")
			.addDropdown((dropdown) => {
				if (same) dropdown.addOption(SAME, "Same as Compile");
				dropdown
					.addOption("", "Claude Code default")
					.addOption("low", "Low")
					.addOption("medium", "Medium")
					.addOption("high", "High")
					.addOption("xhigh", "Extra high")
					.addOption("max", "Max")
					.setValue(row.effort)
					.onChange(async (value) => {
						row.effort = value as CompileEffort;
						await this.plugin.saveSettings();
					});
			});
	}

	/** Permission mode and allowed commands: Claude Code only (AGT-7, AGT-26). */
	private displayPermissions(containerEl: HTMLElement) {
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
				`The folder holding this project's code. Compile runs ${agentName(resolveTask(this.plugin.settings.tasks, "compile").agent)} here.`,
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

/** Asks a yes or no question in a modal. Resolves true only when the engineer clicks `yes`. */
export function confirmChoice(app: App, title: string, question: string, yes: string): Promise<boolean> {
	return new Promise((resolve) => new ConfirmModal(app, title, question, yes, resolve).open());
}

class ConfirmModal extends Modal {
	private answered = false;

	constructor(
		app: App,
		private title: string,
		private question: string,
		private yes: string,
		private onAnswer: (yes: boolean) => void,
	) {
		super(app);
	}

	onOpen() {
		this.setTitle(this.title);
		this.contentEl.createEl("p", { text: this.question });
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(this.yes)
					.setWarning()
					.onClick(() => {
						this.answer(true);
						this.close();
					}),
			);
	}

	private answer(yes: boolean) {
		if (this.answered) return;
		this.answered = true;
		this.onAnswer(yes);
	}

	onClose() {
		this.contentEl.empty();
		// Closing the modal any other way keeps the setting as it was.
		this.answer(false);
	}
}
