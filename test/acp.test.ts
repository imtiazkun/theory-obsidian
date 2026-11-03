import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
	AcpPermissionOption,
	acpOptionId,
	answerFromMessages,
	lastJsonBlock,
	matchEffort,
	matchModel,
	modelChange,
	refusedWrite,
	splitCommand,
} from "../src/acp";
import { COMPILED_TAG, CompileOptions, CompileReport, PermissionRequest, rulesToSave, startCompile } from "../src/compile";
import { initRepo, out, tempFolder, write } from "./helpers";

const ALL_OPTIONS: AcpPermissionOption[] = [
	{ optionId: "once", kind: "allow_once" },
	{ optionId: "always", kind: "allow_always" },
	{ optionId: "no", kind: "reject_once" },
	{ optionId: "never", kind: "reject_always" },
];

const ANSWER = { status: "succeeded", summary: "Done.", changes: ["Changed a thing"], questions: [], problems: [] };

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
		for (const field of ["status", "summary", "changes", "questions", "problems"]) {
			const partial: Record<string, unknown> = { ...ANSWER };
			delete partial[field];
			// The last block wins, even when an earlier one was complete.
			expect(answerFromMessages([JSON.stringify(ANSWER), JSON.stringify(partial)])).toBeNull();
		}
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

	it("matches the model and effort to the agent's choices", () => {
		const models = [
			{ value: "claude-sonnet-5", name: "Sonnet" },
			{ value: "claude-opus-5", name: "Opus" },
		];
		expect(matchModel(models, "opus")).toBe("claude-opus-5");
		expect(matchModel(models, "haiku")).toBeNull();
		expect(matchModel(models, "")).toBeNull();
		const levels = [
			{ value: "low", name: "Low" },
			{ value: "x", name: "Extra high" },
		];
		expect(matchEffort(levels, "xhigh")).toBe("x");
		expect(matchEffort(levels, "low")).toBe("low");
		expect(matchEffort(levels, "max")).toBeNull();
	});
});

/**
 * A small fake ACP agent. It answers initialize and session/new, then on session/prompt it runs the steps
 * in its plan file one by one, and records every answer it gets in its record file.
 */
const FAKE_AGENT = `
import { appendFileSync, readFileSync } from "fs";
const [plan, record] = process.argv.slice(2);
const steps = JSON.parse(readFileSync(plan, "utf8"));
let nextId = 1000;
const waiting = new Map();
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const call = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }); });
const note = (entry) => appendFileSync(record, JSON.stringify(entry) + "\\n");
let buffer = "";
let session = "s1";
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
	if (m.method === "session/new") return send({ id: m.id, result: { sessionId: session } });
	if (m.method === "session/prompt") {
		note({ prompt: m.params.prompt[0].text });
		for (const step of steps) {
			if (step.say) send({ method: "session/update", params: { sessionId: session, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.say } } } });
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
		return send({ id: m.id, result: { stopReason: "end_turn" } });
	}
}
`;

interface Setup {
	vault: string;
	project: string;
	record: string;
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
	return {
		vault,
		project,
		record,
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
				reports: [],
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
		expect(report.changes).toEqual(["Changed a thing"]);
		expect(report.agent).toBe("acp");
		expect(report.tokens).toBeUndefined();
		expect(report.log).toContain("Read Note.md");
		const records = s.records();
		const prompt = records.find((r) => r.prompt)?.prompt as string;
		expect(prompt).toContain("You are compiling a theoretical model into software.");
		expect(prompt).toContain('"required": [\n    "status",');
		const session = records.find((r) => r.received === "session/new")?.params;
		expect(session.cwd).toBe(s.project);
		expect(session.additionalDirectories).toHaveLength(1);
		expect(records.find((r) => r.received === "initialize")?.params.clientCapabilities.terminal).toBe(false);
		await expect(out(s.vault, ["tag", "--list", COMPILED_TAG])).resolves.toBe(COMPILED_TAG);
	});

	it("fails without a structured answer when the last JSON block lacks a field", async () => {
		const s = await setup();
		const { problems, ...partial } = ANSWER;
		const report = await (await compile(s.options([answerStep(), answerStep(partial)]))).done;
		expect(report.status).toBe("failed");
		expect(problemTexts(report).some((p) => p.startsWith("The agent gave no structured answer."))).toBe(true);
		await expect(out(s.vault, ["tag", "--list", COMPILED_TAG])).resolves.toBe(COMPILED_TAG);
	});

	it("denies a change to the model without a card (AGT-12)", async () => {
		const s = await setup();
		const asked: PermissionRequest[] = [];
		const file = join(s.vault, "Note.md");
		const run = await compile(
			s.options([{ ask: { toolCallId: "t1", kind: "edit", title: "Edit Note.md", locations: [{ path: file }] }, options: ALL_OPTIONS }, answerStep()]),
			(request) => asked.push(request),
		);
		const report = await run.done;
		expect(asked).toEqual([]);
		expect(s.records().find((r) => r.permission)?.permission).toEqual({ outcome: "selected", optionId: "no" });
		expect(problemTexts(report)).toContain(`The agent tried to change the model (${file}). That was denied.`);
	});

	it("shows any other request as a card and sends the button as the agent's option (AGT-11, AGT-13)", async () => {
		const s = await setup();
		const asked: PermissionRequest[] = [];
		const steps = [
			{ ask: { toolCallId: "t1", kind: "execute", title: "Run the tests", rawInput: { command: "npm test" } }, options: ALL_OPTIONS },
			{ ask: { toolCallId: "t2", kind: "execute", title: "Build", rawInput: { command: "npm run build" } }, options: ALL_OPTIONS },
			answerStep(),
		];
		const run = await compile(s.options(steps), (request, answer) => {
			asked.push({ ...request });
			answer(asked.length === 1 ? "always" : "deny");
		});
		const report = await run.done;
		expect(asked.map((r) => [r.tool, r.target, r.reason, r.sessionOnly, r.rules])).toEqual([
			["Run", "npm test", "Run the tests", true, []],
			["Run", "npm run build", "Build", true, []],
		]);
		expect(s.records().filter((r) => r.permission).map((r) => r.permission.optionId)).toEqual(["always", "no"]);
		expect(report.log).toContain("Always allowed: npm test");
		expect(problemTexts(report)).toContain("You denied Run: npm run build. The agent carried on without it.");
	});

	it("refuses writes outside the project folder and to the model, and names each in problems (AGT-15)", async () => {
		const s = await setup();
		const inside = join(s.project, "app", "new.txt");
		const outside = join(s.project, "..", "outside.txt");
		const model = join(s.vault, "Note.md");
		const report = await (await compile(s.options([{ write: inside }, { write: outside }, { write: model }, answerStep()]))).done;
		const writes = s.records().filter((r) => r.write);
		expect(writes.map((w) => w.error === null)).toEqual([true, false, false]);
		expect(readFileSync(inside, "utf8")).toBe("written");
		expect(existsSync(outside)).toBe(false);
		expect(readFileSync(model, "utf8")).toBe("# Note\n\nThe rule.\n");
		const problems = problemTexts(report);
		expect(problems.some((p) => p.includes("outside the project folder"))).toBe(true);
		expect(problems.some((p) => p.startsWith("The agent tried to write to the model"))).toBe(true);
	});

	it("answers open requests as cancelled on Cancel, and the marker doesn't move (AGT-18)", async () => {
		const s = await setup();
		const steps = [{ ask: { toolCallId: "t1", kind: "execute", rawInput: { command: "npm test" } }, options: ALL_OPTIONS }];
		let run: Awaited<ReturnType<typeof startCompile>>;
		run = await startCompile({ ...s.options(steps), onPermissionRequest: () => run.cancel() }, () => {});
		const report = await run.done;
		expect(report.status).toBe("cancelled");
		expect(s.records().find((r) => r.permission)?.permission).toEqual({ outcome: "cancelled" });
		expect(s.records().some((r) => r.received === "session/cancel")).toBe(true);
		await expect(out(s.vault, ["tag", "--list", COMPILED_TAG])).resolves.toBe("");
	});
});
