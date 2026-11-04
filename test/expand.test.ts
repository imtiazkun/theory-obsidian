import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
	MAX_EXPAND_SUGGESTIONS,
	buildExpandPrompt,
	createEmptyNote,
	expandCommand,
	expandContext,
	expandRepoFor,
	parseExpandReply,
} from "../src/expand";
import { changedFiles } from "../src/vault";
import { initRepo, out, tempFolder, write } from "./helpers";

const VAULT = {
	"Index.md": "root index\n",
	"Instructions.md": "for humans only\n",
	".obsidian/app.json": "{}\n",
	"_templates/index.md": "template\n",
	"app/index.md": "app index\n",
	"app/instructions.md": "app rules\n",
	"app/Compile.md": "compile\n",
	"app/flows/Login.md": "login\n",
	"app/_drafts/Draft.md": "draft\n",
	"app/.hidden/Secret.md": "secret\n",
	"app/_Scratch.md": "scratch\n",
	"other/index.md": "other index\n",
};

describe("Expand: the context it sends", () => {
	it("sends the model folder's notes as they are now, the root Index, and every note name", async () => {
		const vault = tempFolder();
		await initRepo(vault, VAULT);
		write(vault, { "app/Compile.md": "edited, not committed\n", "app/New.md": "new\n" });

		const context = await expandContext(vault, "app");
		expect(context.index).toEqual({ path: "app/index.md", text: "app index\n" });
		expect(context.instructions).toEqual({ path: "app/instructions.md", text: "app rules\n" });
		expect(context.rootIndex).toEqual({ path: "Index.md", text: "root index\n" });
		expect(context.notes).toEqual([
			{ path: "app/Compile.md", text: "edited, not committed\n" },
			{ path: "app/New.md", text: "new\n" },
			{ path: "app/flows/Login.md", text: "login\n" },
		]);
		expect(context.names.sort()).toEqual(["Compile", "Login", "New", "index", "instructions"]);
	});

	it("never sends hidden folders, hidden notes, the root Instructions or other model folders", async () => {
		const vault = tempFolder();
		await initRepo(vault, VAULT);
		const prompt = buildExpandPrompt(await expandContext(vault, "app"), true);
		expect(prompt).toContain("app index");
		expect(prompt).toContain("root index");
		for (const text of ["for humans only", "draft", "secret", "scratch", "_Scratch", "template", "other index", "{}"]) {
			expect(prompt).not.toContain(text);
		}
	});
});

describe("Expand: the tools it allows", () => {
	it("allows only Read, Glob and Grep inside the repository, when it exists", () => {
		const { args, cwd } = expandCommand({ model: "", effort: "", repoPath: "/work/app" });
		expect(cwd).toBe("/work/app");
		expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
		expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
		expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read(//work/app/**)");
		expect(args).not.toContain("--dangerously-skip-permissions");
	});

	it("allows no tools when the repository doesn't exist", () => {
		const { args, cwd } = expandCommand({ model: "opus", effort: "high", repoPath: null });
		expect(cwd).not.toBe("/work/app");
		expect(args[args.indexOf("--tools") + 1]).toBe("");
		expect(args).not.toContain("--allowedTools");
		expect(args).toEqual(expect.arrayContaining(["--model", "opus", "--effort", "high"]));
	});
});

describe("Expand: what Claude returns", () => {
	it("keeps at most ten suggestions and drops notes that already exist", () => {
		const notes = Array.from({ length: 14 }, (_, i) => ({ name: `Note ${i}`, question: "q", why: "w", headings: ["a", "b"] }));
		notes.unshift({ name: "compile.md", question: "q", why: "w", headings: [] });
		const parsed = parseExpandReply("```json\n" + JSON.stringify({ notes }) + "\n```", ["Compile", "Note 0"]);
		expect(parsed).toHaveLength(MAX_EXPAND_SUGGESTIONS);
		expect(parsed[0]).toEqual({ name: "Note 1", question: "q", why: "w", headings: ["a", "b"] });
		expect(parsed.map((s) => s.name)).not.toContain("compile");
	});

	it("returns an empty list when nothing is missing, and fails on a reply it can't read", () => {
		expect(parseExpandReply('{"notes": []}', [])).toEqual([]);
		expect(() => parseExpandReply("no idea", [])).toThrow();
	});
});

describe("Expand: Create note", () => {
	it("writes an empty note in the model folder and never commits", async () => {
		const vault = tempFolder();
		await initRepo(vault, VAULT);
		const head = await out(vault, ["rev-parse", "HEAD"]);

		const path = await createEmptyNote(vault, "app", "  Settings  ");
		expect(path).toBe("app/Settings.md");
		expect(readFileSync(join(vault, path), "utf8")).toBe("");
		expect(await out(vault, ["rev-parse", "HEAD"])).toBe(head);
		expect(await changedFiles(vault)).toEqual(["app/Settings.md"]);
	});

	it("creates nothing when a note with that name already exists in the model folder", async () => {
		const vault = tempFolder();
		await initRepo(vault, VAULT);
		await expect(createEmptyNote(vault, "app", "login")).rejects.toThrow("login already exists.");
		await expect(createEmptyNote(vault, "app", "Compile.md")).rejects.toThrow("Compile already exists.");
		expect(existsSync(join(vault, "app/login.md"))).toBe(false);
		expect(await changedFiles(vault)).toEqual([]);
	});
});

describe("Expand: the button", () => {
	it("shows only on a model folder's index.md", () => {
		const repos = ["app", "server"];
		expect(expandRepoFor("app/index.md", repos)).toBe("app");
		expect(expandRepoFor("server/INDEX.md", repos)).toBe("server");
		for (const path of ["Index.md", "app/instructions.md", "app/flows/index.md", "App/index.md", "web/index.md", null]) {
			expect(expandRepoFor(path, repos)).toBeNull();
		}
	});
});
