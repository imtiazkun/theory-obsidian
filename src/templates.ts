import { readFile } from "fs/promises";
import { join } from "path";
import { INDEX_TEMPLATE_PATH, INSTRUCTIONS_TEMPLATE_PATH, MODEL_INSTRUCTIONS } from "./starter";
import { findIgnoringCase } from "./vault";

/** The text a model folder's index.md and instructions.md are filled in with. */
export interface TemplateFields {
	name: string;
	description: string;
	purpose: string;
}

/** True when the field was filled in. */
function given(value: string): boolean {
	return value.trim() !== "";
}

/**
 * Replaces `{{name}}`, `{{description}}` and `{{purpose}}` with the fields, exactly as typed.
 * A line holding only a placeholder whose field is empty is left out, with the blank line after it.
 * Every other line stays as it is, including unknown placeholders and `%%` comments.
 */
export function fillTemplate(template: string, fields: TemplateFields): string {
	const values: Record<string, string> = { name: fields.name, description: fields.description, purpose: fields.purpose };
	const lines = template.split("\n");
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const only = /^\s*\{\{(name|description|purpose)\}\}\s*$/.exec(lines[i]);
		if (only && !given(values[only[1]])) {
			if (i + 1 < lines.length - 1 && lines[i + 1].trim() === "") i++;
			continue;
		}
		kept.push(lines[i].replace(/\{\{(name|description|purpose)\}\}/g, (_, key: string) => values[key]));
	}
	return kept.join("\n");
}

/** The built-in index.md, used when `_templates/index.md` is missing or empty. */
export function builtInIndex(fields: TemplateFields): string {
	const parts = ["## What this repository is", fields.description, fields.purpose].filter(given);
	if (parts.length === 1) return `Manifesting ${fields.name}\n`;
	return parts.join("\n\n") + "\n";
}

/** The template's text, or null when it is missing or holds only whitespace. */
async function readTemplate(vaultPath: string, path: string): Promise<string | null> {
	const found = await findIgnoringCase(vaultPath, path);
	if (found === null) return null;
	const text = await readFile(join(vaultPath, found), "utf8").catch(() => null);
	return text !== null && text.trim() !== "" ? text : null;
}

/** A new model folder's index.md and instructions.md, from the templates as they are now. */
export async function modelFolderTexts(vaultPath: string, fields: TemplateFields): Promise<{ index: string; instructions: string }> {
	const index = await readTemplate(vaultPath, INDEX_TEMPLATE_PATH);
	const instructions = await readTemplate(vaultPath, INSTRUCTIONS_TEMPLATE_PATH);
	return {
		index: index === null ? builtInIndex(fields) : fillTemplate(index, fields),
		instructions: instructions === null ? MODEL_INSTRUCTIONS : fillTemplate(instructions, fields),
	};
}
