import { ChildProcess, spawn } from "child_process";
import { existsSync, realpathSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, isAbsolute, resolve, sep } from "path";
import type { AgentHost, AgentOutcome, AgentRun, PermissionAnswer, StructuredAnswer } from "./compile";
import { toolPath } from "./tool-path";

/** After Cancel, an agent that hasn't stopped in this time is stopped by the plugin. */
export const ACP_STOP_AFTER_MS = 5_000;
const ACP_PROTOCOL_VERSION = 1;
// Agents can be chatty on stderr; only the end of it goes into a problem.
const MAX_STDERR_CHARS = 2_000;

/** One answer an ACP agent offers on a permission request. */
export interface AcpPermissionOption {
	optionId: string;
	name?: string;
	kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

/** Splits an agent command like `gemini --experimental-acp` into words, keeping quoted parts together. */
export function splitCommand(command: string): string[] {
	const words: string[] = [];
	let word = "";
	let quote: string | null = null;
	let started = false;
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (quote) {
			if (char === quote) quote = null;
			else if (char === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
			else word += char;
		} else if (char === '"' || char === "'") {
			quote = char;
			started = true;
		} else if (char === "\\" && i + 1 < command.length) {
			word += command[++i];
			started = true;
		} else if (/\s/.test(char)) {
			if (started) words.push(word);
			word = "";
			started = false;
		} else {
			word += char;
			started = true;
		}
	}
	if (started) words.push(word);
	return words;
}

/**
 * The agent's option for a button (AGT-13). Allow is "allow once". Always allow is "allow always",
 * else "allow once". Deny is "reject once", else "reject always". Null when the agent offers none of them.
 */
export function acpOptionId(options: AcpPermissionOption[], answer: PermissionAnswer): string | null {
	const kinds =
		answer === "allow" ? ["allow_once"] : answer === "always" ? ["allow_always", "allow_once"] : ["reject_once", "reject_always"];
	for (const kind of kinds) {
		const option = options.find((o) => o.kind === kind);
		if (option) return option.optionId;
	}
	return null;
}

/**
 * The last JSON object in the agent's messages, whether in a fenced block or not.
 * Undefined when the messages hold none.
 */
export function lastJsonBlock(text: string): unknown {
	let last: unknown = undefined;
	let i = text.indexOf("{");
	while (i >= 0) {
		const end = matchingBrace(text, i);
		if (end >= 0) {
			try {
				last = JSON.parse(text.slice(i, end + 1));
				i = text.indexOf("{", end + 1);
				continue;
			} catch {
				// Not JSON, e.g. braces in prose. Try the next one.
			}
		}
		i = text.indexOf("{", i + 1);
	}
	return last;
}

/** The index of the brace closing the one at `start`, skipping braces inside strings, or -1. */
function matchingBrace(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (char === "\\") i++;
			else if (char === '"') inString = false;
		} else if (char === '"') inString = true;
		else if (char === "{") depth++;
		else if (char === "}" && --depth === 0) return i;
	}
	return -1;
}

/** The compile answer (CMP-15) in `value`, or null when it lacks status, summary, changes, questions or problems. */
export function structuredAnswer(value: unknown): StructuredAnswer | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const answer = value as Record<string, unknown>;
	if (answer.status !== "succeeded" && answer.status !== "failed") return null;
	if (typeof answer.summary !== "string") return null;
	if (!Array.isArray(answer.changes) || !Array.isArray(answer.questions) || !Array.isArray(answer.problems)) return null;
	return answer as unknown as StructuredAnswer;
}

/** The answer read from the last JSON block in the agent's messages (AGT-10), or null when there is none. */
export function answerFromMessages(messages: string[]): StructuredAnswer | null {
	return structuredAnswer(lastJsonBlock(messages.join("\n")));
}

/** `path` with symbolic links resolved, as far as it exists. A file not written yet keeps its own name. */
function realPath(path: string): string {
	let existing = resolve(path);
	const rest: string[] = [];
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) break;
		rest.unshift(existing.slice(parent.length).replace(/^[/\\]/, ""));
		existing = parent;
	}
	let real = existing;
	try {
		real = realpathSync(existing);
	} catch {
		// Keep the path as written.
	}
	return rest.length > 0 ? resolve(real, ...rest) : real;
}

function isInside(path: string, dir: string): boolean {
	const root = realPath(dir);
	return path === root || path.startsWith(root + sep);
}

/**
 * Why a write by the agent must be refused (AGT-15), or null when it may go ahead.
 * Every write outside the project folder, and every write to the vault or the snapshot, is refused.
 */
export function refusedWrite(path: string, projectFolder: string, protectedPaths: string[]): string | null {
	const file = realPath(isAbsolute(path) ? path : resolve(projectFolder, path));
	if (protectedPaths.some((dir) => isInside(file, dir))) {
		return `The agent tried to write to the model (${file}). That was refused.`;
	}
	if (!isInside(file, projectFolder)) {
		return `The agent tried to write ${file}, outside the project folder. That was refused.`;
	}
	return null;
}

const CHANGE_KINDS = ["edit", "delete", "move"];

/** The files an ACP tool call names, made absolute against the project folder. */
function toolCallPaths(toolCall: any, projectFolder: string): string[] {
	const paths: string[] = [];
	const add = (value: unknown) => {
		if (typeof value === "string" && value) paths.push(isAbsolute(value) ? resolve(value) : resolve(projectFolder, value));
	};
	for (const location of Array.isArray(toolCall?.locations) ? toolCall.locations : []) add(location?.path);
	const input = toolCall?.rawInput;
	if (input && typeof input === "object") {
		for (const [key, value] of Object.entries(input)) {
			if (/path|file|destination|source|target/i.test(key)) add(value);
		}
	}
	for (const item of Array.isArray(toolCall?.content) ? toolCall.content : []) {
		if (item?.type === "diff") add(item.path);
	}
	return paths;
}

/**
 * The vault or snapshot file a permission request would edit, delete or move (AGT-12), or null.
 * Such a request is denied before any card is shown.
 */
export function modelChange(toolCall: unknown, projectFolder: string, protectedPaths: string[]): string | null {
	const call = toolCall as any;
	if (!CHANGE_KINDS.includes(call?.kind)) return null;
	for (const path of toolCallPaths(call, projectFolder)) {
		const file = realPath(path);
		if (protectedPaths.some((dir) => isInside(file, dir))) return file;
	}
	return null;
}

const KIND_NAMES: Record<string, string> = {
	read: "Read",
	edit: "Edit",
	delete: "Delete",
	move: "Move",
	search: "Search",
	execute: "Run",
	think: "Think",
	fetch: "Fetch",
};

/** The exact command or file an ACP tool call is about, as shown on its card. */
function requestTarget(toolCall: any, projectFolder: string): string {
	const input = toolCall?.rawInput;
	const command = input?.command;
	if (Array.isArray(command)) return command.join(" ");
	if (typeof command === "string" && command) return command;
	const [path] = toolCallPaths(toolCall, projectFolder);
	if (path) return path;
	if (typeof toolCall?.title === "string" && toolCall.title) return toolCall.title;
	return input ? JSON.stringify(input) : "Unknown tool call";
}

/** A model or thinking-level choice the agent offers for this session. */
interface Choice {
	/** What to send back to pick a value. */
	set: (value: string) => Promise<unknown>;
	options: { value: string; name: string }[];
}

/** Flattens a session config option's values, which may come in groups. */
function configValues(option: any): { value: string; name: string }[] {
	const values: { value: string; name: string }[] = [];
	for (const item of Array.isArray(option?.options) ? option.options : []) {
		if (Array.isArray(item?.options)) values.push(...configValues(item));
		else if (typeof item?.value === "string") values.push({ value: item.value, name: String(item.name ?? item.value) });
	}
	return values;
}

/** The choice whose value or name is the wanted text, ignoring case and surrounding spaces (AGT-23). */
export function matchChoice(options: { value: string; name: string }[], wanted: string): { value: string; name: string } | null {
	const text = wanted.trim().toLowerCase();
	if (!text) return null;
	return options.find((o) => o.value.trim().toLowerCase() === text) ?? options.find((o) => o.name.trim().toLowerCase() === text) ?? null;
}

export interface AcpOptions {
	/** The command that starts the agent, with its arguments. */
	command: string;
	projectFolder: string;
	snapshot: string;
	/** The vault and the snapshot: the agent may never write to them. */
	protectedPaths: string[];
	prompt: string;
	/** The Agent model setting, matched against the agent's model choices. "" means the agent's default. */
	model: string;
	/** The Agent thinking level setting, matched against the agent's thinking-level choices. "" means the agent's default. */
	thinkingLevel: string;
}

/** Runs an Agent Client Protocol agent over stdio for one compile. */
export function runAcpAgent(options: AcpOptions, host: AgentHost): AgentRun {
	const [command, ...args] = splitCommand(options.command);
	const child: ChildProcess = spawn(command, args, {
		cwd: options.projectFolder,
		env: { ...process.env, PATH: toolPath() },
	});
	child.stdin?.on("error", () => {});

	let nextId = 1;
	const calls = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	let sessionId: string | null = null;
	let exited = false;
	let stderr = "";
	// The agent's messages, split where it used a tool. The answer is in the last JSON block among them.
	const messages: string[] = [""];

	const send = (message: unknown) => {
		if (child.stdin?.writable) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...(message as object) }) + "\n");
	};
	const call = (method: string, params: unknown) =>
		new Promise<any>((resolve, reject) => {
			if (exited) return reject(new Error("The agent stopped."));
			const id = nextId++;
			calls.set(id, { resolve, reject });
			send({ id, method, params });
		});
	const respond = (id: unknown, result: unknown) => send({ id, result });
	const fail = (id: unknown, message: string) => send({ id, error: { code: -32000, message } });

	const handlePermission = (id: unknown, params: any) => {
		const toolCall = params?.toolCall ?? {};
		const choices: AcpPermissionOption[] = Array.isArray(params?.options) ? params.options : [];
		const select = (optionId: string | null) =>
			respond(id, { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } });
		const file = modelChange(toolCall, options.projectFolder, options.protectedPaths);
		// Changes to the model never reach a card.
		if (file) {
			host.skip(`The agent tried to change the model (${file}). That was denied.`);
			host.log(`Denied: ${file}`);
			select(acpOptionId(choices, "deny"));
			return;
		}
		const title = typeof toolCall.title === "string" ? toolCall.title : "";
		host.ask(
			{
				id: `acp-${String(id)}`,
				tool: KIND_NAMES[toolCall.kind] ?? "Tool",
				target: requestTarget(toolCall, options.projectFolder),
				reason: title || "The agent didn't give a reason.",
				// Always allow lasts for this compile only and never changes Allowed commands (AGT-14).
				rules: [],
				sessionOnly: true,
			},
			(choice) => (choice === "cancelled" ? select(null) : select(acpOptionId(choices, choice))),
		);
	};

	const handleRequest = async (id: unknown, method: string, params: any) => {
		try {
			if (method === "session/request_permission") return handlePermission(id, params);
			if (method === "fs/read_text_file") {
				const text = await readFile(String(params?.path), "utf8");
				const line = typeof params?.line === "number" ? Math.max(1, params.line) : null;
				const limit = typeof params?.limit === "number" ? params.limit : null;
				if (line === null && limit === null) return respond(id, { content: text });
				const lines = text.split("\n").slice((line ?? 1) - 1);
				return respond(id, { content: (limit === null ? lines : lines.slice(0, limit)).join("\n") });
			}
			if (method === "fs/write_text_file") {
				const path = String(params?.path ?? "");
				const refused = refusedWrite(path, options.projectFolder, options.protectedPaths);
				if (refused) {
					host.skip(refused);
					host.log(`Refused write: ${path}`);
					return fail(id, "This write was refused: the agent may write only inside the project folder, never to the model.");
				}
				const file = isAbsolute(path) ? path : resolve(options.projectFolder, path);
				await mkdir(dirname(file), { recursive: true });
				await writeFile(file, String(params?.content ?? ""));
				return respond(id, null);
			}
			send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
		} catch (error) {
			fail(id, error instanceof Error ? error.message : String(error));
		}
	};

	const handleUpdate = (update: any) => {
		const kind = update?.sessionUpdate;
		if (kind === "agent_message_chunk" && update.content?.type === "text") {
			messages[messages.length - 1] += String(update.content.text ?? "");
		} else if (kind === "tool_call") {
			const title = typeof update.title === "string" && update.title ? update.title : (KIND_NAMES[update.kind] ?? "Tool");
			host.log(title.length > 160 ? title.slice(0, 157) + "…" : title);
			if (messages[messages.length - 1] !== "") messages.push("");
		}
	};

	const handleLine = (line: string) => {
		if (!line.trim()) return;
		let message: any;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof message.method === "string") {
			if (message.id !== undefined && message.id !== null) void handleRequest(message.id, message.method, message.params);
			else if (message.method === "session/update") handleUpdate(message.params?.update);
			return;
		}
		const pending = calls.get(message.id);
		if (!pending) return;
		calls.delete(message.id);
		if (message.error) pending.reject(new Error(String(message.error.message ?? "The agent returned an error.")));
		else pending.resolve(message.result);
	};

	const exit = new Promise<{ code: number | null; error?: Error }>((resolve) => {
		let buffer = "";
		child.stdout?.on("data", (chunk) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			lines.forEach(handleLine);
		});
		child.stderr?.on("data", (chunk) => (stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS)));
		const stopped = () => {
			exited = true;
			for (const pending of calls.values()) pending.reject(new Error("The agent stopped."));
			calls.clear();
		};
		child.on("error", (error) => {
			stopped();
			resolve({ code: null, error });
		});
		child.on("close", (code) => {
			handleLine(buffer);
			stopped();
			resolve({ code });
		});
	});

	/** Picks the model or thinking level the settings ask for, when the agent offers a match (AGT-6, AGT-23). */
	const choose = async (label: string, wanted: string, choice: Choice | null) => {
		if (!wanted.trim()) return;
		const picked = choice ? matchChoice(choice.options, wanted) : null;
		if (!choice || !picked) {
			host.log(`The agent has no ${label} matching "${wanted.trim()}", so it uses its default.`);
			return;
		}
		const shown = picked.name === picked.value ? picked.value : `${picked.name} (${picked.value})`;
		try {
			await choice.set(picked.value);
			host.log(`Using ${label} ${shown}.`);
		} catch {
			host.log(`The agent didn't accept ${label} ${shown}, so it uses its default.`);
		}
	};

	const run = async (): Promise<{ stopReason?: string; error?: string }> => {
		try {
			await call("initialize", {
				protocolVersion: ACP_PROTOCOL_VERSION,
				// No terminal: the agent runs commands itself, and asks first when it wants to (AGT-16).
				clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
				clientInfo: { name: "theory-md", title: "theory.md" },
			});
			const session = await call("session/new", {
				cwd: options.projectFolder,
				mcpServers: [],
				additionalDirectories: [options.snapshot],
			});
			sessionId = String(session?.sessionId ?? "");
			const config: any[] = Array.isArray(session?.configOptions) ? session.configOptions : [];
			const configChoice = (category: string): Choice | null => {
				const option = config.find((o) => o?.category === category);
				if (!option) return null;
				return {
					options: configValues(option),
					set: (value) => call("session/set_config_option", { sessionId, configId: option.id, value }),
				};
			};
			let modelChoice = configChoice("model");
			const models = session?.models;
			if (!modelChoice && Array.isArray(models?.availableModels)) {
				modelChoice = {
					options: models.availableModels.map((m: any) => ({ value: String(m.modelId), name: String(m.name ?? m.modelId) })),
					set: (modelId) => call("session/set_model", { sessionId, modelId }),
				};
			}
			await choose("model", options.model, modelChoice);
			await choose("thinking level", options.thinkingLevel, configChoice("thought_level"));

			const result = await call("session/prompt", { sessionId, prompt: [{ type: "text", text: options.prompt }] });
			return { stopReason: String(result?.stopReason ?? "") };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		} finally {
			// The agent is done; closing stdin and stopping it ends the compile.
			child.stdin?.end();
			if (!exited) child.kill("SIGTERM");
		}
	};

	const done = (async (): Promise<AgentOutcome> => {
		const [turn, { code, error }] = await Promise.all([run(), exit]);
		if (error) return { result: null, code, error, stderr };
		const structured = answerFromMessages(messages);
		const text = [...messages].reverse().find((m) => m.trim() !== "")?.trim() ?? "";
		return {
			result: {
				isError: Boolean(turn.error) || turn.stopReason !== "end_turn",
				text,
				structured: structured ?? undefined,
			},
			code,
			stopReason: turn.error || turn.stopReason || "unknown",
			stderr: stderr.trim(),
		};
	})();

	return {
		done,
		cancel() {
			if (sessionId) send({ method: "session/cancel", params: { sessionId } });
			else child.kill("SIGTERM");
			// An agent that ignores the cancel is stopped.
			setTimeout(() => {
				if (!exited) child.kill("SIGTERM");
			}, ACP_STOP_AFTER_MS).unref?.();
		},
	};
}
