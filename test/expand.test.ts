import { chmodSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	MAX_SUGGESTIONS,
	buildExpandPrompt,
	createExpandNote,
	expandCommand,
	modelFolderOfIndex,
	parseSuggestions,
	readExpandContext,
	startExpand,
} from "../src/expand";
import { repo, sh, tempDir, write } from "./helpers";

function vault() {
	return repo(tempDir(), {
		"Index.md": "The whole system\n",
		"Instructions.md": "HUMAN ONLY RULES\n",
		"_templates/index.md": "TEMPLATE TEXT\n",
		"app/index.md": "- [[Billing]]: payments\n",
		"app/instructions.md": "Never add a dependency.\n",
		"app/Concepts.md": "Words\n",
		"app/flows/Checkout.md": "Checkout\n",
		"app/_drafts/Idea.md": "HIDDEN DRAFT\n",
		"web/index.md": "OTHER REPOSITORY\n",
	});
}

describe("Expand: the context it sends", () => {
	it("sends the folder's index, instructions, other notes, note names and the root Index", async () => {
		const dir = vault();
		const context = await readExpandContext(dir, "app");
		expect(context.index).toEqual({ path: "app/index.md", text: "- [[Billing]]: payments\n" });
		expect(context.instructions).toEqual({ path: "app/instructions.md", text: "Never add a dependency.\n" });
		expect(context.rootIndex).toEqual({ path: "Index.md", text: "The whole system\n" });
		expect(context.notes.map((n) => n.path)).toEqual(["app/Concepts.md", "app/flows/Checkout.md"]);
		expect(context.names).toEqual(["app/Concepts.md", "app/flows/Checkout.md", "app/index.md", "app/instructions.md"]);
	});

	it("reads the notes as they are now, uncommitted edits included", async () => {
		const dir = vault();
		write(dir, "app/index.md", "- [[Billing]]: payments\n- [[Refunds]]: not committed yet\n");
		write(dir, "app/New.md", "Untracked\n");
		const context = await readExpandContext(dir, "app");
		expect(context.index?.text).toContain("not committed yet");
		expect(context.names).toContain("app/New.md");
	});

	it("never sends hidden folders, the root Instructions or other folders", async () => {
		const prompt = buildExpandPrompt(await readExpandContext(vault(), "app"), false);
		expect(prompt).toContain("Never add a dependency.");
		expect(prompt).toContain("The whole system");
		for (const text of ["HUMAN ONLY RULES", "TEMPLATE TEXT", "HIDDEN DRAFT", "_drafts", "OTHER REPOSITORY"]) {
			expect(prompt).not.toContain(text);
		}
	});
});

describe("Expand: the tools it allows", () => {
	it("allows only Read, Glob and Grep inside the repository when it exists", () => {
		const { args, cwd } = expandCommand({ model: "opus", effort: "high", vaultPath: "/vault", repoPath: "/project/app" });
		expect(cwd).toBe("/project/app");
		expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
		expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read(//project/app/**)");
		expect(args[args.indexOf("--disallowedTools") + 1]).toBe("Read(//vault/**)");
		expect(args).not.toContain("bypassPermissions");
		expect(args.join(" ")).not.toMatch(/Edit|Write|Bash|add-dir/);
		expect(args).toEqual(expect.arrayContaining(["--model", "opus", "--effort", "high"]));
	});

	it("allows no tools when the repository doesn't exist yet", () => {
		const { args, cwd } = expandCommand({ model: "", effort: "", vaultPath: "/vault", repoPath: null });
		expect(cwd).toBe(tmpdir());
		expect(args[args.indexOf("--tools") + 1]).toBe("");
		expect(args).not.toContain("--allowedTools");
		expect(args).not.toContain("--model");
	});
});

describe("Expand: what Claude returns", () => {
	it("keeps at most ten suggestions and never one that already exists", () => {
		const list = Array.from({ length: 14 }, (_, i) => ({ name: `Note ${i}`, question: "Q?", reason: "index line", headings: ["A", "B", "C", "D"] }));
		list.unshift({ name: "concepts.md", question: "Q?", reason: "", headings: [] });
		const suggestions = parseSuggestions("```json\n" + JSON.stringify({ suggestions: list }) + "\n```", ["app/Concepts.md"]);
		expect(suggestions).toHaveLength(MAX_SUGGESTIONS);
		expect(suggestions[0]).toEqual({ name: "Note 0", question: "Q?", reason: "index line", headings: ["A", "B", "C"] });
		expect(suggestions.map((s) => s.name)).not.toContain("concepts");
	});

	it("reads Claude Code's answer through a fake claude", async () => {
		const dir = tempDir();
		const argsFile = join(dir, "args.txt");
		const fake = join(dir, "claude");
		const result = JSON.stringify({ result: JSON.stringify({ suggestions: [{ name: "Billing", question: "How are cards charged?", reason: "index: [[Billing]]", headings: ["Charges", "Receipts"] }] }) });
		await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\ncat > /dev/null\nprintf '%s' '${result.replace(/'/g, "'\\''")}'\n`);
		chmodSync(fake, 0o755);
		const context = await readExpandContext(vault(), "app");
		const run = startExpand({ claudeCommand: fake, model: "", effort: "", vaultPath: "/vault", repoPath: null, context });
		expect(await run.done).toEqual([{ name: "Billing", question: "How are cards charged?", reason: "index: [[Billing]]", headings: ["Charges", "Receipts"] }]);
		expect(readFileSync(argsFile, "utf8")).toContain("--tools\n\n");
	});
});

describe("Expand: Create note", () => {
	function noteVault(dir: string) {
		return {
			files: () => sh(dir, ["ls-files", "--cached", "--others"]).split("\n").filter(Boolean),
			create: (path: string, text: string) => writeFile(join(dir, path), text, { flag: "wx" }),
		};
	}

	it("writes an empty note in the model folder and never commits", async () => {
		const dir = vault();
		const head = sh(dir, ["rev-parse", "HEAD"]);
		expect(await createExpandNote(noteVault(dir), "app", "  Billing.md ")).toEqual({ created: true, path: "app/Billing.md" });
		expect(readFileSync(join(dir, "app/Billing.md"), "utf8")).toBe("");
		expect(sh(dir, ["rev-parse", "HEAD"])).toBe(head);
		expect(sh(dir, ["status", "--porcelain"])).toBe("?? app/Billing.md");
	});

	it("creates nothing when the note already exists in the model folder", async () => {
		const dir = vault();
		expect(await createExpandNote(noteVault(dir), "app", "concepts")).toEqual({ created: false, reason: "concepts already exists." });
		expect(await createExpandNote(noteVault(dir), "app", "Checkout")).toEqual({ created: false, reason: "Checkout already exists." });
		expect(sh(dir, ["status", "--porcelain"])).toBe("");
	});
});

describe("Expand: the button", () => {
	it("shows only on a model folder's index.md", () => {
		expect(modelFolderOfIndex("app/index.md", ["app", "web"])).toBe("app");
		expect(modelFolderOfIndex("web/INDEX.md", ["app", "web"])).toBe("web");
		expect(modelFolderOfIndex("Index.md", ["app"])).toBeNull();
		expect(modelFolderOfIndex("notes/index.md", ["app"])).toBeNull();
		expect(modelFolderOfIndex("app/sub/index.md", ["app"])).toBeNull();
		expect(modelFolderOfIndex("app/instructions.md", ["app"])).toBeNull();
	});
});
