import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
	AcpPermissionOption,
	acpOptionId,
	answerFromMessages,
	lastJsonBlock,
	matchChoice,
	modelChange,
	refusedWrite,
	splitCommand,
} from "../src/acp";
import {
	BUILD_SCHEMA,
	COMPILED_TAG,
	CompileOptions,
	CompileReport,
	PermissionRequest,
	createSnapshot,
	removeSnapshot,
	rulesToSave,
	startCompile,
	startSession,
} from "../src/compile";
import { FakeGitHub } from "./fake-github";
import { initRepo, out, tempFolder, write } from "./helpers";

const ALL_OPTIONS: AcpPermissionOption[] = [
	{ optionId: "once", kind: "allow_once" },
	{ optionId: "always", kind: "allow_always" },
	{ optionId: "no", kind: "reject_once" },
	{ optionId: "never", kind: "reject_always" },
];

const PLAN = { issues: [{ repo: "app", title: "Add a thing", body: "The app needs a thing.", rules: ["R-1"], shortName: "add-thing" }] };
const ANSWER = { status: "succeeded", summary: "Done.", plan: PLAN, questions: [], problems: [] };
const BUILD_ANSWER = { status: "succeeded", summary: "Done.", changes: ["Changed a thing"], questions: [], problems: [] };

describe("ACP permission options (AGT-13)", () => {
	it("sends each button as the agent's matching option", () => {
		expect(acpOptionId(ALL_OPTIONS, "allow")).toBe("once");
		expect(acpOptionId(ALL_OPTIONS, "always")).toBe("always");
		expect(acpOptionId(ALL_OPTIONS, "deny")).toBe("no");
	});

	it("falls back to allow once and reject always", () => {
		const options = ALL_OPTIONS.filter((o) => o.kind === "allow_once" || o.kind === "reject_always");
		expect(acpOptionId(options, "always")).toBe("once");
		expect(acpOptionId(options, "deny")).toBe("never");
		expect(acpOptionId([], "allow")).toBeNull();
	});

	it("never saves an ACP card's Always allow to Allowed commands (AGT-14)", () => {
		const request: PermissionRequest = {
			id: "acp-1",
			tool: "Run",
			target: "npm test",
			reason: "Run tests",
			rules: [],
			sessionOnly: true,
			expiresAt: 0,
			line: 0,
		};
		expect(rulesToSave(request, "always")).toEqual([]);
		const claude = { ...request, sessionOnly: undefined, rules: ["Bash(npm test)"] };
		expect(rulesToSave(claude, "always")).toEqual(["Bash(npm test)"]);
		expect(rulesToSave(claude, "allow")).toEqual([]);
	});
});

describe("the ACP answer (AGT-10)", () => {
	it("reads the last JSON block in the agent's messages", () => {
		const first = { ...ANSWER, summary: "First." };
		const messages = [
			`Planning {not json} here.\n\`\`\`json\n${JSON.stringify(first)}\n\`\`\``,
			`All done.\n\`\`\`json\n${JSON.stringify(ANSWER, null, 2)}\n\`\`\`\nBye.`,
		];
		expect(answerFromMessages(messages)?.summary).toBe("Done.");
		// Without a fence too, and with braces inside strings.
		const braces = { ...ANSWER, summary: "Uses {curly} braces and \"quotes\"." };
		expect(answerFromMessages([`Answer: ${JSON.stringify(braces)}`])?.summary).toBe(braces.summary);
	});

	it("has no answer when there is no JSON block, or the last one lacks a field", () => {
		expect(answerFromMessages(["I changed the code."])).toBeNull();
		for (const field of ["status", "summary", "plan", "questions", "problems"]) {
			const partial: Record<string, unknown> = { ...ANSWER };
			delete partial[field];
			// The last block wins, even when an earlier one was complete.
			expect(answerFromMessages([JSON.stringify(ANSWER), JSON.stringify(partial)])).toBeNull();
		}
		// A build's answer has changes instead of a plan.
		for (const field of BUILD_SCHEMA.required) {
			const partial: Record<string, unknown> = { ...BUILD_ANSWER };
			delete partial[field];
			expect(answerFromMessages([JSON.stringify(partial)], BUILD_SCHEMA.required)).toBeNull();
		}
		expect(answerFromMessages([JSON.stringify(BUILD_ANSWER)], BUILD_SCHEMA.required)?.changes).toEqual(["Changed a thing"]);
		expect(answerFromMessages([JSON.stringify({ ...ANSWER, status: "done" })])).toBeNull();
		expect(lastJsonBlock("a {b} c")).toBeUndefined();
	});
});

describe("ACP model protection (AGT-12, AGT-15)", () => {
	it("finds edits, deletes and moves of vault or snapshot files", () => {
		const root = tempFolder();
		const [vault, snapshot, project] = ["vault", "snapshot", "project"].map((name) => join(root, name));
		write(root, { "vault/a.md": "a", "snapshot/a.md": "a", "project/x.ts": "x" });
		const paths = [vault, snapshot];
		expect(modelChange({ kind: "edit", locations: [{ path: join(vault, "a.md") }] }, project, paths)).toBe(join(vault, "a.md"));
		expect(modelChange({ kind: "delete", rawInput: { file_path: join(snapshot, "a.md") } }, project, paths)).toBe(
			join(snapshot, "a.md"),
		);
		expect(modelChange({ kind: "move", rawInput: { source: "x.ts", destination: "../vault/b.md" } }, project, paths)).toBe(
			join(vault, "b.md"),
		);
		expect(modelChange({ kind: "edit", locations: [{ path: join(project, "x.ts") }] }, project, paths)).toBeNull();
		// Reading the model is fine.
		expect(modelChange({ kind: "read", locations: [{ path: join(vault, "a.md") }] }, project, paths)).toBeNull();
	});

	it("refuses every write outside the project folder and to the model", () => {
		const root = tempFolder();
		const [vault, project] = ["vault", "project"].map((name) => join(root, name));
		write(root, { "vault/a.md": "a", "project/x.ts": "x" });
		expect(refusedWrite(join(project, "src/new.ts"), project, [vault])).toBeNull();
		expect(refusedWrite("x.ts", project, [vault])).toBeNull();
		expect(refusedWrite(join(root, "other.txt"), project, [vault])).toMatch(/outside the project folder/);
		expect(refusedWrite(join(project, "../vault/a.md"), project, [vault])).toMatch(/to the model/);
		// The vault inside the project folder is still the model.
		expect(refusedWrite(join(project, "model/a.md"), project, [join(project, "model")])).toMatch(/to the model/);
	});
});

describe("ACP settings (AGT-5, AGT-6)", () => {
	it("splits the agent command into words", () => {
		expect(splitCommand("gemini --experimental-acp")).toEqual(["gemini", "--experimental-acp"]);
		expect(splitCommand(`"/Applications/My Agent/agent" --acp ''`)).toEqual(["/Applications/My Agent/agent", "--acp", ""]);
		expect(splitCommand("  ")).toEqual([]);
	});

	it("matches a setting to the agent's choices by value or by name (AGT-23)", () => {
		const models = [
			{ value: "claude-sonnet-5", name: "Sonnet" },
			{ value: "claude-opus-5", name: "Opus" },
		];
		expect(matchChoice(models, "claude-opus-5")).toEqual({ value: "claude-opus-5", name: "Opus" });
		expect(matchChoice(models, " sonnet ")).toEqual({ value: "claude-sonnet-5", name: "Sonnet" });
		expect(matchChoice(models, "opus-5")).toBeNull();
		expect(matchChoice(models, "haiku")).toBeNull();
		expect(matchChoice(models, "")).toBeNull();
		const levels = [
			{ value: "low", name: "Low" },
			{ value: "x", name: "Extra high" },
		];
		expect(matchChoice(levels, "extra high")?.value).toBe("x");
		expect(matchChoice(levels, "low")?.value).toBe("low");
	});
});

const FAKE_AGENT = `
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
const [plan, record] = process.argv.slice(2);
const steps = JSON.parse(readFileSync(plan, "utf8"));
let nextId = 1000;
const waiting = new Map();
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const call = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }); });
const note = (entry) => appendFileSync(record, JSON.stringify(entry) + "\\n");
let buffer = "";
let session = "s1";
let extraFolder = "";
let cancelled;
const cancel = new Promise((resolve) => (cancelled = resolve));
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	const lines = buffer.split("\\n");
	buffer = lines.pop();
	for (const line of lines) if (line.trim()) handle(JSON.parse(line));
});
async function handle(m) {
	if (m.method === undefined) { waiting.get(m.id)?.(m); waiting.delete(m.id); return; }
	note({ received: m.method, params: m.method === "session/prompt" ? undefined : m.params });
	if (m.method === "session/cancel") return cancelled();
	if (m.method === "initialize") return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
	if (m.method === "session/new") {
		extraFolder = m.params.additionalDirectories[0];
		const offers = steps.find((step) => step.offers)?.offers ?? {};
		return send({ id: m.id, result: { sessionId: session, ...offers } });
	}
	if (m.method === "session/set_model" || m.method === "session/set_config_option") return send({ id: m.id, result: {} });
	if (m.method === "session/prompt") {
		note({ prompt: m.params.prompt[0].text });
		for (const step of steps) {
			if (step.say) send({ method: "session/update", params: { sessionId: session, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.say } } } });
			// Its own shell can write anywhere, past the plugin's file access (AGT-17).
			if (step.touch) writeFileSync(step.touch, "touched");
			if (step.touchSnapshot) {
				// The snapshot is read-only, but nothing stops a shell from making it writable again.
				chmodSync(join(extraFolder, step.touchSnapshot), 0o644);
				writeFileSync(join(extraFolder, step.touchSnapshot), "touched");
			}
			if (step.stderr) process.stderr.write(step.stderr);
			if (step.hang) {
				send({ method: "session/update", params: { sessionId: session, update: { sessionUpdate: "tool_call", toolCallId: "h", title: "Waiting" } } });
				await cancel;
				return send({ id: m.id, result: { stopReason: "cancelled" } });
			}
			if (step.tool) send({ method: "session/update", params: { sessionId: session, update: { sessionUpdate: "tool_call", toolCallId: "t", title: step.tool } } });
			if (step.ask) {
				const answer = await call("session/request_permission", { sessionId: session, toolCall: step.ask, options: step.options });
				note({ permission: answer.result?.outcome });
				if (answer.result?.outcome?.outcome === "cancelled") {
					await cancel;
					return send({ id: m.id, result: { stopReason: "cancelled" } });
				}
			}
			if (step.write) {
				const answer = await call("fs/write_text_file", { sessionId: session, path: step.write, content: "written" });
				note({ write: step.write, error: answer.error?.message ?? null });
			}
		}
		return send({ id: m.id, result: { stopReason: steps.find((step) => step.stop)?.stop ?? "end_turn" } });
	}
}
`;

interface Setup {
	vault: string;
	project: string;
	record: string;
	github: FakeGitHub;
	options: (steps: unknown[], extra?: Partial<CompileOptions>) => CompileOptions;
	records: () => any[];
}

/** A vault with one pending revision, a project with one repository, and a fake agent, all in a temp folder. */
async function setup(): Promise<Setup> {
	const root = tempFolder();
	const vault = join(root, "vault");
	const project = join(root, "project");
	await initRepo(vault, { "Note.md": "# Note\n\nThe rule.\n" });
	await initRepo(join(project, "app"));
	write(root, { "agent/agent.mjs": FAKE_AGENT });
	const plan = join(root, "agent", "plan.json");
	const record = join(root, "agent", "record.jsonl");
	const github = new FakeGitHub();
	return {
		vault,
		project,
		record,
		github,
		options: (steps, extra = {}) => {
			writeFileSync(plan, JSON.stringify(steps));
			return {
				vaultPath: vault,
				projectFolder: project,
				claudeCommand: "claude",
				agent: "acp",
				agentCommand: `"${process.execPath}" "${join(root, "agent", "agent.mjs")}" "${plan}" "${record}"`,
				permissionMode: "acceptEdits",
				allowedTools: "Bash(git *)",
				model: "",
				effort: "",
				author: "Test Author",
				githubProject: "https://github.com/orgs/team/projects/1",
				github,
				...extra,
			};
		},
		records: () =>
			existsSync(record)
				? readFileSync(record, "utf8")
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line))
				: [],
	};
}

const answerStep = (answer: object = ANSWER) => ({ say: `Finished.\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`` });

async function compile(options: CompileOptions, onAsk?: (request: PermissionRequest, answer: (a: "allow" | "always" | "deny") => void) => void) {
	let run: Awaited<ReturnType<typeof startCompile>>;
	run = await startCompile(
		{ ...options, onPermissionRequest: (request) => onAsk?.(request, (a) => run.answer(request.id, a)) },
		() => {},
	);
	return run;
}

const problemTexts = (report: CompileReport) => report.problems.map((p) => p.text);

describe("compiling with an ACP agent", () => {
	it("won't start without an agent command, and the marker doesn't move (AGT-5)", async () => {
		const s = await setup();
		await expect(startCompile({ ...s.options([]), agentCommand: "  " }, () => {})).rejects.toThrow(
			"Set the agent command in theory.md settings first.",
		);
		await expect(out(s.vault, ["tag", "--list", COMPILED_TAG])).resolves.toBe("");
	});

	it("fails with the agent's command when it isn't found, and the marker doesn't move (AGT-19)", async () => {
		const s = await setup();
		const run = await compile({ ...s.options([]), agentCommand: "theory-no-such-agent --acp" });
		const report = await run.done;
		expect(report.status).toBe("failed");
		expect(problemTexts(report)).toContain(
			`Couldn't find the agent ("theory-no-such-agent --acp"). Set its command in theory.md settings.`,
		);
		await expect(out(s.vault, ["tag", "--list", COMPILED_TAG])).resolves.toBe("");
	});

	it("sends the prompt with the answer's shape and reads the answer from the last JSON block (AGT-9, AGT-10)", async () => {
		const s = await setup();
		const run = await compile(s.options([{ tool: "Read Note.md" }, answerStep({ ...ANSWER, summary: "Early." }), answerStep()]));
		const report = await run.done;
		expect(report.status).toBe("succeeded");
		expect(report.summary).toBe("Done.");
		expect(report.issues?.map((i) => [i.repo, i.title, i.number])).toEqual([["app", "Add a thing", 1]]);
		expect(report.agent).toBe("acp");
		expect(report.tokens).toBeUndefined();
		expect(report.log).toContain("Read Note.md");
		const records = s.records();
		const prompt = records.find((r) => r.prompt)?.prompt as string;
		expect(prompt).toContain("You are compiling a theoretical model into a plan of work.");
		expect(prompt).toContain('"required": [\n    "status",');
		const session = records.find((r) => r.received === "session/new")?.params;
		expect(session.cwd).toBe(s.project);
		expect(session.additionalDirectories).toHaveLength(1);
		expect(records.find((r) => r.received === "initialize")?.params.clientCapabilities.terminal).toBe(false);
		await expect(out(s.vault, ["tag", "--list", COMPILED_TAG])).resolves.toBe(COMPILED_TAG);
	});

	it("picks the agent model and thinking level from the agent's choices, never Claude Code's (AGT-6, AGT-23, AGT-24)", async () => {
		const s = await setup();
		const offers = {
			models: { availableModels: [{ modelId: "gemini-pro", name: "Gemini Pro" }, { modelId: "opus", name: "Opus" }] },
			configOptions: [{ id: "thinking", category: "thought_level", options: [{ value: "hi", name: "High" }] }],
		};
		const run = await compile({
			...s.options([{ offers }, answerStep()]),
			model: "opus",
			effort: "max",
			agentModel: "Gemini Pro",
			agentThinkingLevel: "high",
		});
		const report = await run.done;
		expect(report.log).toContain("Using model Gemini Pro (gemini-pro).");
		expect(report.log).toContain("Using thinking level High (hi).");
		const records = s.records();
		expect(records.find((r) => r.received === "session/set_model")?.params.modelId).toBe("gemini-pro");
		expect(records.find((r) => r.received === "session/set_config_option")?.params).toMatchObject({ configId: "thinking", value: "hi" });
	});

	it("says the agent uses its default when it has no match, and sends nothing for empty fields (AGT-6, AGT-23)", async () => {
		const s = await setup();
		const offers = { models: { availableModels: [{ modelId: "gemini-pro", name: "Gemini Pro" }] } };
		const run = await compile({ ...s.options([{ offers }, answerStep()]), agentModel: "gpt-9", model: "opus", effort: "high" });
		const report = await run.done;
		expect(report.log).toContain('The agent has no model matching "gpt-9", so it uses its default.');
		expect(report.log.some((line) => line.includes("thinking level"))).toBe(false);
		const records = s.records();
		expect(records.some((r) => r.received === "session/set_model" || r.received === "session/set_config_option")).toBe(false);
	});

	it("fails without a structured answer when the last JSON block lacks a field", async () => {
		const s = await setup();
		const { problems, ...partial } = ANSWER;
		const report = await (await compile(s.options([answerStep(), answerStep(partial)]))).done;
		expect(report.status).toBe("failed");
		expect(problemTexts(report).some((p) => p.startsWith("The agent gave no structured answer."))).toBe(true);
		await expect(out(s.vault, ["tag", "--list", COMPILED_TAG])).resolves.toBe(COMPILED_TAG);
	});

	it("says why the agent stopped and the end of its error output, never the exit code (AGT-22)", async () => {
		const s = await setup();
		const steps = [{ say: "I ran out of room." }, { stderr: "context window full\n" }, { stop: "max_tokens" }];
		const report = await (await compile(s.options(steps))).done;
		expect(report.status).toBe("failed");
		const problem = problemTexts(report).find((p) => p.startsWith("The agent gave no structured answer."));
		expect(problem).toBe("The agent gave no structured answer. It stopped because: max_tokens. context window full");
		expect(problemTexts(report).some((p) => p.includes("exit"))).toBe(false);
	});

	it("is read-only: writes and commands are denied without a card, and no code repository changes (CMP-13, CMP-69)", async () => {
		const s = await setup();
		const app = join(s.project, "app");
		const before = await out(app, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const asked: PermissionRequest[] = [];
		const steps = [
			{ ask: { toolCallId: "t1", kind: "execute", title: "Run the tests", rawInput: { command: "npm test" } }, options: ALL_OPTIONS },
			{ ask: { toolCallId: "t2", kind: "read", title: "Read a file", locations: [{ path: join(app, "README.md") }] }, options: ALL_OPTIONS },
			{ write: join(app, "new.txt") },
			answerStep(),
		];
		const report = await (await compile(s.options(steps), (request) => asked.push(request))).done;
		expect(asked).toEqual([]);
		// Reading is allowed, running a command isn't.
		expect(s.records().filter((r) => r.permission).map((r) => r.permission.optionId)).toEqual(["no", "once"]);
		expect(s.records().find((r) => r.write)?.error).not.toBeNull();
		expect(s.records().find((r) => r.received === "initialize")?.params.clientCapabilities.fs.writeTextFile).toBe(false);
		expect(existsSync(join(app, "new.txt"))).toBe(false);
		expect(problemTexts(report)).toContain("A compile only reads, so Run: npm test was denied.");
		expect(await out(app, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(before);
		expect(await out(app, ["status", "--porcelain"])).toBe("");
		expect(await out(app, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
	});

	it("fails when the agent's own shell changed a code repository during the compile (CMP-69)", async () => {
		const s = await setup();
		const report = await (await compile(s.options([{ touch: join(s.project, "app", "README.md") }, answerStep()]))).done;
		expect(report.status).toBe("failed");
		expect(problemTexts(report)).toContain("These repositories changed during the compile: app. A compile never changes code, so check them.");
		expect(s.github.issues).toEqual([]);
	});

	it("checks the snapshot and the vault after a cancelled compile, and keeps it cancelled (INV-12)", async () => {
		const s = await setup();
		const steps = [{ touch: join(s.vault, "Note.md"), touchSnapshot: "Note.md" }, { hang: true }];
		let run: Awaited<ReturnType<typeof startCompile>>;
		let cancelled = false;
		run = await startCompile(s.options(steps), (report) => {
			if (!cancelled && report.log.includes("Waiting")) {
				cancelled = true;
				run.cancel();
			}
		});
		const report = await run.done;
		expect(report.status).toBe("cancelled");
		expect(report.summary).toBe("You cancelled this compile. The last compile marker didn't move.");
		const problems = problemTexts(report);
		expect(problems.some((p) => p.startsWith("These vault files changed while the compile ran: Note.md."))).toBe(true);
		expect(problems).toContain("Claude tried to change the model snapshot. Those changes were thrown away.");
		expect(s.records().some((r) => r.received === "session/cancel")).toBe(true);
		await expect(out(s.vault, ["tag", "--list", COMPILED_TAG])).resolves.toBe("");
		expect(s.github.issues).toEqual([]);
	});
});

/** One build session with the fake agent in the repository `app`, as Build runs it for one issue. */
async function buildSession(
	s: Setup,
	steps: unknown[],
	onAsk?: (request: PermissionRequest, answer: (a: "allow" | "always" | "deny") => void, cancel: () => void) => void,
) {
	const options = s.options(steps);
	const snapshot = await createSnapshot(s.vault, "HEAD");
	const report = { log: [] as string[] };
	let session: ReturnType<typeof startSession>;
	session = startSession({
		settings: options,
		cwd: join(s.project, "app"),
		snapshot,
		protectedPaths: [s.vault, snapshot],
		prompt: "Build the issue.",
		schema: BUILD_SCHEMA,
		readOnly: false,
		what: "build",
		report,
		onUpdate: () => {},
		onPermissionRequest: (request) =>
			onAsk?.(
				request,
				(a) => session.answer(request.id, a),
				() => session.cancel(),
			),
	});
	const outcome = await session.done;
	await removeSnapshot(snapshot);
	return { ...outcome, log: report.log };
}

describe("an ACP agent in a build", () => {
	const buildAnswer = { say: `Finished.\n\`\`\`json\n${JSON.stringify(BUILD_ANSWER)}\n\`\`\`` };

	it("reads the build's answer, with changes (AGT-10)", async () => {
		const s = await setup();
		const outcome = await buildSession(s, [buildAnswer]);
		expect(outcome.result?.structured?.changes).toEqual(["Changed a thing"]);
		const session = s.records().find((r) => r.received === "session/new")?.params;
		expect(session.cwd).toBe(join(s.project, "app"));
	});

	it("denies a change to the model without a card (AGT-12)", async () => {
		const s = await setup();
		const asked: PermissionRequest[] = [];
		const file = join(s.vault, "Note.md");
		const outcome = await buildSession(
			s,
			[{ ask: { toolCallId: "t1", kind: "edit", title: "Edit Note.md", locations: [{ path: file }] }, options: ALL_OPTIONS }, buildAnswer],
			(request) => asked.push(request),
		);
		expect(asked).toEqual([]);
		expect(s.records().find((r) => r.permission)?.permission).toEqual({ outcome: "selected", optionId: "no" });
		expect(outcome.skipped).toContain(`The agent tried to change the model (${file}). That was denied.`);
	});

	it("shows any other request as a card and sends the button as the agent's option (AGT-11, AGT-13)", async () => {
		const s = await setup();
		const asked: PermissionRequest[] = [];
		const steps = [
			{ ask: { toolCallId: "t1", kind: "execute", title: "Run the tests", rawInput: { command: "npm test" } }, options: ALL_OPTIONS },
			{ ask: { toolCallId: "t2", kind: "execute", title: "Build", rawInput: { command: "npm run build" } }, options: ALL_OPTIONS },
			buildAnswer,
		];
		const outcome = await buildSession(s, steps, (request, answer) => {
			asked.push({ ...request });
			answer(asked.length === 1 ? "always" : "deny");
		});
		expect(asked.map((r) => [r.tool, r.target, r.reason, r.sessionOnly, r.rules])).toEqual([
			["Run", "npm test", "Run the tests", true, []],
			["Run", "npm run build", "Build", true, []],
		]);
		expect(s.records().filter((r) => r.permission).map((r) => r.permission.optionId)).toEqual(["always", "no"]);
		expect(outcome.log).toContain("Always allowed: npm test");
		expect(outcome.skipped).toContain("You denied Run: npm run build. The agent carried on without it.");
	});

	it("refuses writes outside its repository and to the model, and names each in problems (AGT-15)", async () => {
		const s = await setup();
		const inside = join(s.project, "app", "new.txt");
		const outside = join(s.project, "..", "outside.txt");
		const model = join(s.vault, "Note.md");
		const outcome = await buildSession(s, [{ write: inside }, { write: outside }, { write: model }, buildAnswer]);
		const writes = s.records().filter((r) => r.write);
		expect(writes.map((w) => w.error === null)).toEqual([true, false, false]);
		expect(readFileSync(inside, "utf8")).toBe("written");
		expect(existsSync(outside)).toBe(false);
		expect(readFileSync(model, "utf8")).toBe("# Note\n\nThe rule.\n");
		expect(outcome.skipped.some((p) => p.includes("outside the project folder"))).toBe(true);
		expect(outcome.skipped.some((p) => p.startsWith("The agent tried to write to the model"))).toBe(true);
	});

	it("answers open requests as cancelled on Cancel (AGT-18)", async () => {
		const s = await setup();
		const steps = [{ ask: { toolCallId: "t1", kind: "execute", rawInput: { command: "npm test" } }, options: ALL_OPTIONS }];
		await buildSession(s, steps, (_request, _answer, cancel) => cancel());
		expect(s.records().find((r) => r.permission)?.permission).toEqual({ outcome: "cancelled" });
		expect(s.records().some((r) => r.received === "session/cancel")).toBe(true);
	});
});
