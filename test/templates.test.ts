import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import type TheoryPlugin from "../src/main";
import { addModelFolder } from "../src/repositories";
import { MODEL_INSTRUCTIONS, starterFiles } from "../src/starter";
import { builtInIndex, fillTemplate, modelFolderTexts } from "../src/templates";
import { changedFiles } from "../src/vault";
import { initRepo, out, tempFolder, write } from "./helpers";

const FULL = { name: "billing", description: "Bills customers.", purpose: "Line one.\nLine two." };
const EMPTY = { name: "billing", description: "", purpose: "" };
const INDEX_TEMPLATE = starterFiles("Model").find((file) => file.path === "_templates/index.md")!.content;

describe("filling a template", () => {
	it("replaces the placeholders exactly as typed", () => {
		expect(fillTemplate("# {{name}}\n\n{{description}}\n\n{{purpose}}\n", FULL)).toBe("# billing\n\nBills customers.\n\nLine one.\nLine two.\n");
		expect(fillTemplate("{{name}} does {{description}}", { ...FULL, description: "  *odd* $& text  " })).toBe("billing does   *odd* $& text  ");
	});

	it("leaves out a line holding only an empty field's placeholder, with the blank line after it", () => {
		expect(fillTemplate(INDEX_TEMPLATE, EMPTY)).toBe(INDEX_TEMPLATE.replace("{{description}}\n\n{{purpose}}\n\n", ""));
		expect(fillTemplate("A\n\n{{description}}\n\n{{purpose}}\n\nB\n", { ...FULL, description: "" })).toBe("A\n\nLine one.\nLine two.\n\nB\n");
		expect(fillTemplate("A\n{{purpose}}\n", EMPTY)).toBe("A\n");
	});

	it("keeps unknown placeholders, comments and lines where an empty placeholder isn't alone", () => {
		const template = "{{owner}}\n\n%% {{purpose}} goes here %%\n\nAbout: {{description}}\n";
		expect(fillTemplate(template, EMPTY)).toBe("{{owner}}\n\n%%  goes here %%\n\nAbout: \n");
	});
});

describe("model folder texts", () => {
	it("fill the vault's templates as they are now", async () => {
		const vault = tempFolder();
		write(vault, { "_templates/index.md": "# {{name}}\n\n{{description}}\n", "_templates/instructions.md": "Rules for {{name}}.\n" });
		expect(await modelFolderTexts(vault, FULL)).toEqual({ index: "# billing\n\nBills customers.\n", instructions: "Rules for billing.\n" });

		write(vault, { "_templates/index.md": "Changed {{name}}\n" });
		expect((await modelFolderTexts(vault, FULL)).index).toBe("Changed billing\n");
	});

	it("find templates under another case", async () => {
		const vault = tempFolder();
		write(vault, { "_Templates/INDEX.md": "# {{name}}\n" });
		expect((await modelFolderTexts(vault, EMPTY)).index).toBe("# billing\n");
	});

	it("use the built-in text when a template is missing", async () => {
		const vault = tempFolder();
		expect(await modelFolderTexts(vault, FULL)).toEqual({
			index: "## What this repository is\n\nBills customers.\n\nLine one.\nLine two.\n",
			instructions: MODEL_INSTRUCTIONS,
		});
		expect(await modelFolderTexts(vault, EMPTY)).toEqual({ index: "Manifesting billing\n", instructions: MODEL_INSTRUCTIONS });
	});

	it("use the built-in text when a template holds only whitespace", async () => {
		const vault = tempFolder();
		write(vault, { "_templates/index.md": " \n\n\t\n", "_templates/instructions.md": "" });
		expect(await modelFolderTexts(vault, { ...FULL, purpose: "" })).toEqual({
			index: "## What this repository is\n\nBills customers.\n",
			instructions: MODEL_INSTRUCTIONS,
		});
	});

	it("built-in index says Manifesting when the description and purpose are empty", () => {
		expect(builtInIndex(EMPTY)).toBe("Manifesting billing\n");
	});
});

describe("Add model folder", () => {
	it("commits only index.md and instructions.md from the templates, never the templates", async () => {
		const vault = tempFolder();
		await initRepo(vault, { "_templates/index.md": "# {{name}}\n\n{{description}}\n\n{{purpose}}\n\nEnd\n" });
		// A template edit not committed yet, and another note in progress.
		write(vault, { "_templates/instructions.md": "Only {{name}}.\n", "Draft.md": "draft\n" });
		const plugin = {
			settings: {},
			getVaultPath: () => vault,
			app: {
				vault: {
					getAbstractFileByPath: (path: string) => (existsSync(join(vault, path)) ? {} : null),
					createFolder: async (path: string) => mkdirSync(join(vault, path)),
					create: async (path: string, text: string) => writeFileSync(join(vault, path), text),
				},
			},
		} as unknown as TheoryPlugin;

		await addModelFolder(plugin, EMPTY, "Add model folder for billing");

		expect(readFileSync(join(vault, "billing/index.md"), "utf8")).toBe("# billing\n\nEnd\n");
		expect(readFileSync(join(vault, "billing/instructions.md"), "utf8")).toBe("Only billing.\n");
		expect((await out(vault, ["show", "--name-only", "--format=%s", "HEAD"])).split("\n").filter(Boolean)).toEqual([
			"Add model folder for billing",
			"billing/index.md",
			"billing/instructions.md",
		]);
		expect((await changedFiles(vault)).sort()).toEqual(["Draft.md", "_templates/instructions.md"]);
	});
});
