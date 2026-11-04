import { existsSync, readFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { MODEL_INSTRUCTIONS, WELCOME_TEXT, starterFiles } from "../src/starter";
import { addMissingStarterFiles, changedFiles, missingStarters, setUpVault } from "../src/vault";
import { initRepo, out, tempFolder, write } from "./helpers";

const STARTERS = starterFiles("Model");

async function missingPaths(vault: string) {
	const missing = await missingStarters(vault, STARTERS);
	return { files: missing.files.map((file) => file.path), lines: missing.gitignoreLines };
}

/** Paths in the newest commit. */
async function committed(vault: string): Promise<string[]> {
	return (await out(vault, ["show", "--name-only", "--format=", "HEAD"])).split("\n").filter(Boolean).sort();
}

describe("Setup vault", () => {
	it("writes every starter file, the templates included, and commits them", async () => {
		const vault = tempFolder();
		await setUpVault(vault, STARTERS);

		expect(await committed(vault)).toEqual([".gitignore", "Index.md", "Instructions.md", "_templates/index.md", "_templates/instructions.md"]);
		expect(readFileSync(join(vault, "_templates/instructions.md"), "utf8")).toBe(MODEL_INSTRUCTIONS);
		expect(readFileSync(join(vault, "_templates/index.md"), "utf8")).toMatch(/^## What this repository is\n\n\{\{description\}\}\n\n\{\{purpose\}\}\n\n## Its place in the system\n/);
		expect(await missingPaths(vault)).toEqual({ files: [], lines: [] });
	});

	it("keeps starter files that exist under another case", async () => {
		const vault = tempFolder();
		write(vault, { "index.md": "mine\n", "INSTRUCTION.md": "mine\n", "_Templates/Index.md": "mine\n" });
		await setUpVault(vault, STARTERS);

		expect(readFileSync(join(vault, "index.md"), "utf8")).toBe("mine\n");
		expect(readFileSync(join(vault, "_Templates/Index.md"), "utf8")).toBe("mine\n");
		expect(existsSync(join(vault, "Instructions.md"))).toBe(false);
		// The missing template goes into the folder that is already there.
		expect(readFileSync(join(vault, "_Templates/instructions.md"), "utf8")).toBe(MODEL_INSTRUCTIONS);
	});
});

describe("the welcome note", () => {
	it("replaces Obsidian's Welcome.md with the welcome text, renames it to _welcome.md and commits it", async () => {
		const vault = tempFolder();
		write(vault, { "welcome.MD": "This is your new vault.\n" });
		expect(await setUpVault(vault, STARTERS)).toBe(true);

		expect(readdirSync(vault).filter((name) => name.toLowerCase().includes("welcome"))).toEqual(["_welcome.md"]);
		expect(readFileSync(join(vault, "_welcome.md"), "utf8")).toBe(WELCOME_TEXT);
		expect(WELCOME_TEXT).toMatch(/^# Welcome to theory\.md\n/);
		expect(await committed(vault)).toContain("_welcome.md");
		expect(await changedFiles(vault)).toEqual([]);
	});

	it("isn't written when the vault has no Welcome.md", async () => {
		const vault = tempFolder();
		expect(await setUpVault(vault, STARTERS)).toBe(false);
		expect(readdirSync(vault).some((name) => name.toLowerCase().includes("welcome"))).toBe(false);
	});

	it("leaves both notes alone when _welcome.md exists", async () => {
		const vault = tempFolder();
		write(vault, { "Welcome.md": "Obsidian's\n", "_Welcome.md": "kept\n" });
		expect(await setUpVault(vault, STARTERS)).toBe(false);
		expect(readFileSync(join(vault, "Welcome.md"), "utf8")).toBe("Obsidian's\n");
		expect(readFileSync(join(vault, "_Welcome.md"), "utf8")).toBe("kept\n");
	});

	it("is never a missing starter file, and Create missing files never writes it back", async () => {
		const vault = tempFolder();
		write(vault, { "Welcome.md": "Obsidian's\n" });
		await setUpVault(vault, STARTERS);
		rmSync(join(vault, "_welcome.md"));
		await out(vault, ["commit", "-am", "Read it"]);

		expect(await missingPaths(vault)).toEqual({ files: [], lines: [] });
		expect(await addMissingStarterFiles(vault, STARTERS)).toBe(0);
		expect(existsSync(join(vault, "_welcome.md"))).toBe(false);
	});
});

describe("missing starter files", () => {
	it("counts a file as present under any of its names, ignoring case", async () => {
		const vault = tempFolder();
		write(vault, { "INDEX.md": "x\n", "instructions.md": "x\n", "_TEMPLATES/INSTRUCTIONS.MD": "x\n", ".gitignore": ".DS_Store\n.obsidian/\n" });
		expect(await missingPaths(vault)).toEqual({ files: ["_templates/index.md"], lines: [".trash/"] });
	});

	it("lists everything in an empty folder", async () => {
		const vault = tempFolder();
		expect(await missingPaths(vault)).toEqual({
			files: ["Index.md", "Instructions.md", "_templates/index.md", "_templates/instructions.md"],
			lines: [".DS_Store", ".trash/", ".obsidian/"],
		});
	});

	it("a template in another folder doesn't count", async () => {
		const vault = tempFolder();
		write(vault, { "repo/_templates/index.md": "x\n", "_templates.md": "x\n" });
		expect((await missingPaths(vault)).files).toContain("_templates/index.md");
	});
});

describe("Create missing files", () => {
	/** A vault set up by an older version: no templates, and a .gitignore without `.trash/`. */
	async function oldVault() {
		const vault = tempFolder();
		await initRepo(vault, { "Index.md": "my index\n", "Instructions.md": "my rules\n", ".gitignore": "secret.md\n.DS_Store\n.obsidian/" });
		return vault;
	}

	it("writes only the missing files and lines, and never changes a file that exists", async () => {
		const vault = await oldVault();
		const added = await addMissingStarterFiles(vault, STARTERS);

		expect(added).toBe(3);
		expect(readFileSync(join(vault, "Index.md"), "utf8")).toBe("my index\n");
		expect(readFileSync(join(vault, "Instructions.md"), "utf8")).toBe("my rules\n");
		expect(readFileSync(join(vault, ".gitignore"), "utf8")).toBe("secret.md\n.DS_Store\n.obsidian/\n.trash/\n");
		expect(readFileSync(join(vault, "_templates/instructions.md"), "utf8")).toBe(MODEL_INSTRUCTIONS);
		expect(await missingPaths(vault)).toEqual({ files: [], lines: [] });
	});

	it("commits only the files it wrote, signed by the author, and leaves other changes uncommitted", async () => {
		const vault = await oldVault();
		write(vault, { "Index.md": "edited\n", "Draft.md": "draft\n" });
		await out(vault, ["add", "Draft.md"]);

		await addMissingStarterFiles(vault, STARTERS);

		expect(await committed(vault)).toEqual([".gitignore", "_templates/index.md", "_templates/instructions.md"]);
		expect(await out(vault, ["log", "-1", "--format=%an <%ae>|%s"])).toBe("Test Author <test@example.com>|Add missing starter files");
		expect((await changedFiles(vault)).sort()).toEqual(["Draft.md", "Index.md"]);
	});

	it("writes a deleted starter file again", async () => {
		const vault = await oldVault();
		await addMissingStarterFiles(vault, STARTERS);
		rmSync(join(vault, "Index.md"));

		expect(await addMissingStarterFiles(vault, STARTERS)).toBe(1);
		expect(readFileSync(join(vault, "Index.md"), "utf8")).toBe("Manifesting Model\n");
		expect(await committed(vault)).toEqual(["Index.md"]);
	});

	it("needs an author first, and then writes and commits nothing", async () => {
		const vault = await oldVault();
		const head = await out(vault, ["rev-parse", "HEAD"]);
		const env = process.env.GIT_CONFIG_GLOBAL;
		process.env.GIT_CONFIG_GLOBAL = join(vault, "no-such-config");
		try {
			await expect(addMissingStarterFiles(vault, STARTERS)).rejects.toThrow("Set your name and email in git first.");
		} finally {
			process.env.GIT_CONFIG_GLOBAL = env;
		}
		expect(existsSync(join(vault, "_templates"))).toBe(false);
		expect(await out(vault, ["rev-parse", "HEAD"])).toBe(head);
	});
});
