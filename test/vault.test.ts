import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { starterFiles } from "../src/starter";
import { INDEX_TEMPLATE, MODEL_INSTRUCTIONS } from "../src/templates";
import { addMissingStarterFiles, changedFiles, commit, missingStarterFiles, setUpVault } from "../src/vault";
import { AUTHOR, repo, sh, tempDir, write } from "./helpers";

const committedFiles = (dir: string, ref = "HEAD") =>
	sh(dir, ["show", "--name-only", "--format=", ref]).split("\n").filter(Boolean).sort();

function vault(gitignore = ".obsidian/\n") {
	const dir = repo(tempDir(), { ".gitignore": gitignore, "Index.md": "Index\n", "Notes.md": "Notes\n" });
	return dir;
}

describe("changed files and commits", () => {
	it("commits one note and leaves the other changes uncommitted", async () => {
		const dir = vault();
		write(dir, "Index.md", "Index, edited\n");
		write(dir, "Notes.md", "Notes, edited\n");
		write(dir, "New.md", "New\n");
		sh(dir, ["add", "Notes.md"]);
		expect((await changedFiles(dir)).sort()).toEqual(["Index.md", "New.md", "Notes.md"]);

		await commit(dir, AUTHOR, "Update Index", ["Index.md"]);
		expect(committedFiles(dir)).toEqual(["Index.md"]);
		expect(sh(dir, ["log", "-1", "--format=%an <%ae> %s"])).toBe("Test Author <test@example.com> Update Index");
		expect((await changedFiles(dir)).sort()).toEqual(["New.md", "Notes.md"]);
	});

	it("commits all changed files", async () => {
		const dir = vault();
		write(dir, "Index.md", "Index, edited\n");
		write(dir, "folder/New.md", "New\n");
		await commit(dir, AUTHOR, "Update model", "all");
		expect(committedFiles(dir)).toEqual(["Index.md", "folder/New.md"]);
		expect(await changedFiles(dir)).toEqual([]);
	});

	it("never counts or commits .obsidian/ when git ignores it", async () => {
		const dir = vault();
		write(dir, ".obsidian/app.json", "{}\n");
		write(dir, "Index.md", "Index, edited\n");
		expect(await changedFiles(dir)).toEqual(["Index.md"]);
		await commit(dir, AUTHOR, "Update model", "all");
		expect(committedFiles(dir)).toEqual(["Index.md"]);
	});

	it("never counts or commits .obsidian/ in a vault that tracks it from before", async () => {
		const dir = repo(tempDir(), { "Index.md": "Index\n", ".obsidian/app.json": "{}\n" });
		write(dir, ".obsidian/app.json", '{"changed": true}\n');
		write(dir, "Index.md", "Index, edited\n");
		expect(await changedFiles(dir)).toEqual(["Index.md"]);
		await commit(dir, AUTHOR, "Update model", "all");
		expect(committedFiles(dir)).toEqual(["Index.md"]);
		expect(sh(dir, ["status", "--porcelain"])).toBe("M .obsidian/app.json");
	});
});

describe("missing starter files", () => {
	it("counts a file missing only when no accepted name exists, ignoring case", async () => {
		const dir = repo(tempDir(), {
			".gitignore": ".DS_Store\n",
			"index.md": "Mine\n",
			"INSTRUCTION.md": "Mine\n",
			"_Templates/Index.md": "Mine\n",
		});
		expect(await missingStarterFiles(dir, starterFiles("vault"))).toEqual({
			files: ["_templates/instructions.md"],
			gitignoreLines: [".trash/", ".obsidian/"],
		});
	});

	it("counts nothing missing in a vault Setup made", async () => {
		const dir = tempDir();
		await setUpVault(dir, AUTHOR, starterFiles("vault"));
		expect(await missingStarterFiles(dir, starterFiles("vault"))).toEqual({ files: [], gitignoreLines: [] });
		expect(readFileSync(join(dir, "_templates/index.md"), "utf8")).toBe(INDEX_TEMPLATE);
		expect(readFileSync(join(dir, "_templates/instructions.md"), "utf8")).toBe(MODEL_INSTRUCTIONS);
	});

	it("writes only the missing files, never changes existing ones, and commits only what it wrote", async () => {
		const dir = repo(tempDir(), { ".gitignore": "*.log\n.DS_Store\n", "Index.md": "My index\n", "Notes.md": "Notes\n" });
		write(dir, "Notes.md", "Notes, not committed yet\n");
		write(dir, "Draft.md", "Draft\n");

		const added = await addMissingStarterFiles(dir, AUTHOR, starterFiles("vault"));
		expect(added).toBe(4);
		expect(readFileSync(join(dir, "Index.md"), "utf8")).toBe("My index\n");
		expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("*.log\n.DS_Store\n.trash/\n.obsidian/\n");
		expect(committedFiles(dir)).toEqual([".gitignore", "Instructions.md", "_templates/index.md", "_templates/instructions.md"]);
		expect(sh(dir, ["log", "-1", "--format=%an %s"])).toBe("Test Author Add missing starter files");
		expect((await changedFiles(dir)).sort()).toEqual(["Draft.md", "Notes.md"]);
		expect(await missingStarterFiles(dir, starterFiles("vault"))).toEqual({ files: [], gitignoreLines: [] });
	});

	it("writes and commits nothing without an author", async () => {
		const dir = repo(tempDir(), { "Index.md": "Index\n" });
		const head = sh(dir, ["rev-parse", "HEAD"]);
		await expect(addMissingStarterFiles(dir, { fullName: "", email: "" }, starterFiles("vault"))).rejects.toThrow(
			"Set your full name in theory.md settings first.",
		);
		expect(sh(dir, ["rev-parse", "HEAD"])).toBe(head);
		expect(sh(dir, ["status", "--porcelain"])).toBe("");
	});
});
