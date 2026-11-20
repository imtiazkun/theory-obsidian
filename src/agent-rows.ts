import type { AgentSettings, CompileAgent, CompileEffort, CompileModel } from "./compile";

/** The tasks that each have their own row in the settings (CFG-41). Writing is commit messages, pull request bodies and Suggest. */
export type Task = "compile" | "build" | "expand" | "writing";

export const TASKS: readonly Task[] = ["compile", "build", "expand", "writing"];

export const TASK_NAMES: Record<Task, string> = {
	compile: "Compile",
	build: "Build",
	expand: "Expand",
	writing: "Writing",
};

/** "Same as Compile": the value follows Compile's row as it changes (CFG-42). */
export const SAME = "same";
export type Same = typeof SAME;

/** Compile's row. It holds the agent, model and effort compiles used before rows existed (CFG-42). */
export interface CompileRow {
	agent: CompileAgent;
	/** The command that starts the ACP agent, with its arguments. Empty by default (AGT-5). */
	agentCommand: string;
	/** The ACP agent's model and thinking level, kept apart from Claude Code's model and effort (AGT-6, AGT-24). */
	agentModel: string;
	agentThinkingLevel: string;
	model: CompileModel;
	effort: CompileEffort;
}

/** Build's row. Its agent may be "Same as Compile", which follows Compile's whole row (AGT-4). */
export interface BuildRow {
	agent: CompileAgent | Same;
	agentCommand: string;
	agentModel: string;
	agentThinkingLevel: string;
	model: CompileModel | Same;
	effort: CompileEffort | Same;
}

/** Expand's and Writing's rows: always Claude Code, with their own model and effort (CFG-43). */
export interface ClaudeRow {
	model: CompileModel | Same;
	effort: CompileEffort | Same;
}

export interface TaskRows {
	compile: CompileRow;
	build: BuildRow;
	expand: ClaudeRow;
	writing: ClaudeRow;
}

export function defaultTaskRows(): TaskRows {
	return {
		compile: { agent: "claude", agentCommand: "", agentModel: "", agentThinkingLevel: "", model: "", effort: "" },
		build: { agent: SAME, agentCommand: "", agentModel: "", agentThinkingLevel: "", model: SAME, effort: SAME },
		expand: { model: SAME, effort: SAME },
		writing: { model: SAME, effort: SAME },
	};
}

const MODELS: readonly string[] = ["", "fable", "opus", "sonnet", "haiku"];
const EFFORTS: readonly string[] = ["", "low", "medium", "high", "xhigh", "max"];
const AGENTS: readonly string[] = ["claude", "acp"];

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const pick = <T extends string>(value: unknown, allowed: readonly string[], fallback: T): T =>
	typeof value === "string" && allowed.includes(value) ? (value as T) : fallback;
const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * The task rows from saved plugin data. Data saved before rows existed has a single `agent`, `agentCommand`,
 * `agentModel`, `agentThinkingLevel`, `model` and `effort`: they become Compile's row, and every other row is
 * "Same as Compile", so an upgrade never changes how a vault works (CFG-42, AGT-3).
 */
export function savedTaskRows(saved: Record<string, unknown>): TaskRows {
	const rows = defaultTaskRows();
	if (saved.tasks === undefined) {
		rows.compile = {
			agent: pick(saved.agent, AGENTS, "claude"),
			agentCommand: text(saved.agentCommand),
			agentModel: text(saved.agentModel),
			agentThinkingLevel: text(saved.agentThinkingLevel),
			model: pick(saved.model, MODELS, ""),
			effort: pick(saved.effort, EFFORTS, ""),
		};
		return rows;
	}
	const tasks = record(saved.tasks);
	const compile = record(tasks.compile);
	const build = record(tasks.build);
	const expand = record(tasks.expand);
	const writing = record(tasks.writing);
	rows.compile = {
		agent: pick(compile.agent, AGENTS, "claude"),
		agentCommand: text(compile.agentCommand),
		agentModel: text(compile.agentModel),
		agentThinkingLevel: text(compile.agentThinkingLevel),
		model: pick(compile.model, MODELS, ""),
		effort: pick(compile.effort, EFFORTS, ""),
	};
	rows.build = {
		agent: pick(build.agent, [...AGENTS, SAME], SAME),
		agentCommand: text(build.agentCommand),
		agentModel: text(build.agentModel),
		agentThinkingLevel: text(build.agentThinkingLevel),
		model: pick(build.model, [...MODELS, SAME], SAME),
		effort: pick(build.effort, [...EFFORTS, SAME], SAME),
	};
	// Expand and Writing never take an agent, whatever the data says (CFG-43).
	rows.expand = { model: pick(expand.model, [...MODELS, SAME], SAME), effort: pick(expand.effort, [...EFFORTS, SAME], SAME) };
	rows.writing = { model: pick(writing.model, [...MODELS, SAME], SAME), effort: pick(writing.effort, [...EFFORTS, SAME], SAME) };
	return rows;
}

/** Plugin data fields from before rows existed. They are read into Compile's row and never saved again. */
export const OLD_AGENT_FIELDS = ["agent", "agentCommand", "agentModel", "agentThinkingLevel", "model", "effort"] as const;

/** The agent a task runs with, as concrete values, read once when the task starts (CFG-19). */
export interface ResolvedTask {
	agent: CompileAgent;
	agentCommand: string;
	agentModel: string;
	agentThinkingLevel: string;
	model: CompileModel;
	effort: CompileEffort;
}

/**
 * Claude Code's model and effort for a row that may say "Same as Compile".
 * Each field follows Compile's on its own. The model hasn't said yet whether Expand and Writing follow
 * Compile field by field or as a whole row; this is the one place to change if it says the latter.
 */
function claudeModelAndEffort(row: ClaudeRow, compile: CompileRow): { model: CompileModel; effort: CompileEffort } {
	return {
		model: row.model === SAME ? compile.model : row.model,
		effort: row.effort === SAME ? compile.effort : row.effort,
	};
}

/** Turns "Same as Compile" into Compile's values, for the task about to run. Expand and Writing never resolve to ACP (CFG-43). */
export function resolveTask(rows: TaskRows, task: Task): ResolvedTask {
	const compile = rows.compile;
	switch (task) {
		case "compile":
			return { ...compile };
		case "build": {
			const build = rows.build;
			if (build.agent === SAME) return { ...compile };
			return {
				agent: build.agent,
				agentCommand: build.agentCommand,
				agentModel: build.agentModel,
				agentThinkingLevel: build.agentThinkingLevel,
				...claudeModelAndEffort(build, compile),
			};
		}
		case "expand":
		case "writing":
			return {
				agent: "claude",
				agentCommand: "",
				agentModel: "",
				agentThinkingLevel: "",
				...claudeModelAndEffort(rows[task], compile),
			};
	}
}

/** The agent settings a compile or a build starts with: its row, resolved, plus the shared Claude Code settings. */
export function taskAgentSettings(
	settings: { tasks: TaskRows; claudeCommand: string; permissionMode: AgentSettings["permissionMode"]; allowedTools: string },
	task: "compile" | "build",
): AgentSettings {
	return {
		...resolveTask(settings.tasks, task),
		claudeCommand: settings.claudeCommand,
		permissionMode: settings.permissionMode,
		allowedTools: settings.allowedTools,
	};
}

/** How the settings name a row's agent (AGT-28). */
export function agentName(agent: CompileAgent): string {
	return agent === "acp" ? "the ACP agent" : "Claude Code";
}
