import { describe, expect, it } from "vitest";
import { INDEX_TEMPLATE, MODEL_INSTRUCTIONS, fillTemplate, modelFolderTexts } from "../src/templates";
import { tempDir, write } from "./helpers";

const fields = { name: "billing", description: "Takes payments.", purpose: "Charges cards.\nSends receipts." };
const empty = { name: "billing", description: "", purpose: "" };

describe("templates for index.md and instructions.md", () => {
	it("fills the placeholders exactly as typed", () => {
		expect(fillTemplate("# {{name}}\n\n{{description}}\n\n{{purpose}}\n", fields)).toBe(
			"# billing\n\nTakes payments.\n\nCharges cards.\nSends receipts.\n",
		);
	});

	it("leaves out a line holding only an empty field's placeholder, with the blank line after it", () => {
		expect(fillTemplate(INDEX_TEMPLATE, empty)).toBe(INDEX_TEMPLATE.replace("{{description}}\n\n{{purpose}}\n\n", ""));
		expect(fillTemplate("# {{name}}\n\n{{description}}\n\n{{purpose}}\n\nEnd\n", { ...fields, purpose: "" })).toBe(
			"# billing\n\nTakes payments.\n\nEnd\n",
		);
	});

	it("keeps unknown placeholders, %% comments and every other line", () => {
		expect(fillTemplate("{{owner}}\n%% {{name}} notes %%\nAbout {{description}}\n", empty)).toBe("{{owner}}\n%% billing notes %%\nAbout \n");
	});

	it("reads the templates at that moment", async () => {
		const vault = tempDir();
		write(vault, "_templates/index.md", "## {{name}}\n\n{{description}}\n");
		write(vault, "_templates/instructions.md", "Rules for {{name}}.\n");
		expect(await modelFolderTexts(vault, fields)).toEqual({ index: "## billing\n\nTakes payments.\n", instructions: "Rules for billing.\n" });
		write(vault, "_templates/index.md", "Edited {{name}}\n");
		expect((await modelFolderTexts(vault, fields)).index).toBe("Edited billing\n");
	});

	it("uses the built-in text when a template is missing", async () => {
		const vault = tempDir();
		expect(await modelFolderTexts(vault, fields)).toEqual({
			index: "## What this repository is\n\nTakes payments.\n\nCharges cards.\nSends receipts.\n",
			instructions: MODEL_INSTRUCTIONS,
		});
		expect((await modelFolderTexts(vault, empty)).index).toBe("## What this repository is\n\nManifesting billing\n");
	});

	it("uses the built-in text when a template holds only whitespace", async () => {
		const vault = tempDir();
		write(vault, "_templates/index.md", "  \n\n");
		write(vault, "_templates/instructions.md", "\n");
		expect(await modelFolderTexts(vault, empty)).toEqual({
			index: "## What this repository is\n\nManifesting billing\n",
			instructions: MODEL_INSTRUCTIONS,
		});
	});
});
