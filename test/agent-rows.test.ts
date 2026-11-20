import { chmodSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { SAME, TASKS, defaultTaskRows, resolveTask, savedTaskRows, taskAgentSettings } from "../src/agent-rows";
import { generateCommitMessage } from "../src/commit-message";
import { initRepo, tempFolder, write } from "./helpers";

const OLD_DATA = {
	agent: "acp",
	agentCommand: " gemini --experimental-acp ",
	agentModel: "gemini-pro",
	agentThinkingLevel: "high",
	model: "opus",
	effort: "xhigh",
};

describe("task rows: the migration from older settings (CFG-42, AGT-3)", () => {
	it("makes the old single agent, model and effort Compile's row, and every other row Same as Compile", () => {
		const rows = savedTaskRows(OLD_DATA);
		expect(rows.compile).toEqual({
			agent: "acp",
			agentCommand: "gemini --experimental-acp",
			agentModel: "gemini-pro",
			agentThinkingLevel: "high",
			model: "opus",
			effort: "xhigh",
		});
		expect(rows.build).toMatchObject({ agent: SAME, model: SAME, effort: SAME });
		expect(rows.expand).toEqual({ model: SAME, effort: SAME });
		expect(rows.writing).toEqual({ model: SAME, effort: SAME });
	});

	it("so every task runs as it did before the upgrade", () => {
		const rows = savedTaskRows({ model: "sonnet", effort: "low" });
		for (const task of TASKS) expect(resolveTask(rows, task)).toMatchObject({ agent: "claude", model: "sonnet", effort: "low" });
		expect(resolveTask(savedTaskRows(OLD_DATA), "build")).toMatchObject({ agent: "acp", agentCommand: "gemini --experimental-acp" });
	});

	it("gives a new install Claude Code with its defaults", () => {
		expect(savedTaskRows({})).toEqual(defaultTaskRows());
		expect(resolveTask(savedTaskRows({}), "compile")).toEqual({
			agent: "claude",
			agentCommand: "",
			agentModel: "",
			agentThinkingLevel: "",
			model: "",
			effort: "",
		});
	});

	it("reads saved rows, and ignores the old fields once rows exist", () => {
		const tasks = defaultTaskRows();
		tasks.compile.model = "haiku";
		tasks.build = { agent: "claude", agentCommand: "", agentModel: "", agentThinkingLevel: "", model: "opus", effort: "max" };
		tasks.writing = { model: "haiku", effort: "low" };
		const rows = savedTaskRows({ ...OLD_DATA, tasks: JSON.parse(JSON.stringify(tasks)) });
		expect(rows).toEqual(tasks);
	});

	it("drops values that aren't choices", () => {
		const rows = savedTaskRows({ tasks: { compile: { agent: "other", model: "gpt", effort: 3 }, build: { agent: "bogus" } } });
		expect(rows.compile).toMatchObject({ agent: "claude", model: "", effort: "" });
		expect(rows.build.agent).toBe(SAME);
	});
});

describe("task rows: Same as Compile (CFG-42)", () => {
	it("follows Compile's row as it changes", () => {
		const rows = defaultTaskRows();
		rows.compile.model = "opus";
		rows.compile.effort = "high";
		for (const task of TASKS) expect(resolveTask(rows, task)).toMatchObject({ model: "opus", effort: "high" });
		rows.compile.model = "haiku";
		rows.compile.agent = "acp";
		rows.compile.agentCommand = "agent --acp";
		rows.compile.agentModel = "m1";
		expect(resolveTask(rows, "build")).toEqual({ ...rows.compile });
		expect(resolveTask(rows, "expand")).toMatchObject({ agent: "claude", model: "haiku", effort: "high" });
		expect(resolveTask(rows, "writing")).toMatchObject({ agent: "claude", model: "haiku", effort: "high" });
	});

	it("stops following once a row chooses its own values", () => {
		const rows = defaultTaskRows();
		rows.compile.model = "opus";
		rows.build.agent = "claude";
		rows.build.model = "sonnet";
		rows.expand.effort = "low";
		rows.writing.model = "haiku";
		expect(resolveTask(rows, "build")).toMatchObject({ agent: "claude", model: "sonnet", effort: "" });
		expect(resolveTask(rows, "expand")).toMatchObject({ model: "opus", effort: "low" });
		expect(resolveTask(rows, "writing")).toMatchObject({ model: "haiku", effort: "" });
	});

	it("keeps Build's ACP fields apart from its Claude Code model and effort (AGT-24)", () => {
		const rows = defaultTaskRows();
		rows.build = { agent: "acp", agentCommand: "codex-acp", agentModel: "gpt", agentThinkingLevel: "high", model: "opus", effort: "max" };
		expect(resolveTask(rows, "build")).toMatchObject({ agent: "acp", agentCommand: "codex-acp", agentModel: "gpt", agentThinkingLevel: "high" });
		rows.build.agent = "claude";
		expect(resolveTask(rows, "build")).toMatchObject({ agent: "claude", model: "opus", effort: "max" });
	});

	it("gives a running task a copy, so a later change to the row doesn't reach it (CFG-19)", () => {
		const rows = defaultTaskRows();
		const settings = { tasks: rows, claudeCommand: "claude", permissionMode: "acceptEdits" as const, allowedTools: "Bash(git *)" };
		const started = taskAgentSettings(settings, "build");
		rows.compile.model = "opus";
		expect(started).toMatchObject({ agent: "claude", model: "", permissionMode: "acceptEdits", allowedTools: "Bash(git *)" });
	});
});

describe("task rows: Expand and Writing (CFG-43, AGT-2)", () => {
	it("never resolve to an ACP agent, even when Compile and Build use one", () => {
		const rows = savedTaskRows(OLD_DATA);
		rows.build = { agent: "acp", agentCommand: "x", agentModel: "y", agentThinkingLevel: "z", model: SAME, effort: SAME };
		for (const task of ["expand", "writing"] as const) {
			expect(resolveTask(rows, task)).toEqual({
				agent: "claude",
				agentCommand: "",
				agentModel: "",
				agentThinkingLevel: "",
				model: "opus",
				effort: "xhigh",
			});
		}
	});

	it("never read an agent from saved data", () => {
		const rows = savedTaskRows({ tasks: { expand: { agent: "acp", agentCommand: "x", model: "haiku" } } });
		expect(rows.expand).toEqual({ model: "haiku", effort: SAME });
		expect(resolveTask(rows, "expand").agent).toBe("claude");
	});
});

/** A fake Claude Code for one-shot `--output-format json` runs, which records its arguments. */
function fakeWritingClaude() {
	const dir = tempFolder();
	const record = join(dir, "args.json");
	write(dir, {
		"fake.mjs": `import { writeFileSync } from "fs";
const args = process.argv.slice(3);
process.stdin.resume();
process.stdin.on("end", () => {
	writeFileSync(process.argv[2], JSON.stringify(args));
	process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "Add a rule" }));
});
`,
	});
	const command = join(dir, "claude");
	writeFileSync(command, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake.mjs")}" "${record}" "$@"\n`);
	chmodSync(command, 0o755);
	return { command, args: (): string[] => JSON.parse(readFileSync(record, "utf8")) };
}

describe("the commit message uses the Writing row (CMT-7)", () => {
	it("passes the Writing row's model and effort to Claude Code", async () => {
		const vault = tempFolder();
		await initRepo(vault, { "Note.md": "# Note\n" });
		write(vault, { "Note.md": "# Note\n\nA new rule.\n" });
		const claude = fakeWritingClaude();
		const rows = defaultTaskRows();
		rows.compile.model = "opus";
		rows.writing = { model: "haiku", effort: "low" };
		const { model, effort } = resolveTask(rows, "writing");

		const message = await generateCommitMessage(vault, ["Note.md"], { claudeCommand: claude.command, model, effort });
		expect(message).toBe("Add a rule");
		const args = claude.args();
		expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "haiku"]);
		expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual(["--effort", "low"]);
	});

	it("passes no model or effort when they are Claude Code's default", async () => {
		const vault = tempFolder();
		await initRepo(vault, { "Note.md": "# Note\n" });
		write(vault, { "Note.md": "# Note\n\nA new rule.\n" });
		const claude = fakeWritingClaude();
		const { model, effort } = resolveTask(defaultTaskRows(), "writing");
		await generateCommitMessage(vault, ["Note.md"], { claudeCommand: claude.command, model, effort });
		expect(claude.args()).not.toContain("--model");
		expect(claude.args()).not.toContain("--effort");
	});
});
