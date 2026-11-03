import { readFile, readdir } from "fs/promises";
import { join } from "path";

/** The folder at the vault root that holds the templates. It is a hidden folder, so it is never sent to Claude. */
export const TEMPLATES_FOLDER = "_templates";

/** The built-in text of a model folder's instructions.md, and the starter text of its template. */
export const MODEL_INSTRUCTIONS =
	"The writing rules in [the root Instructions](../Instructions.md) apply here. Rules for Claude that apply only to this repository go below.\n";

/** The starter text of `_templates/index.md` (SET-13). */
export const INDEX_TEMPLATE = `## What this repository is

{{description}}

{{purpose}}

## Its place in the system

%% What it depends on, and what depends on it. Link the other repositories' index notes. %%

## What it does not do

%% What people might expect here but lives elsewhere, or nowhere. %%

## Notes

%% One line per note: the question it answers and its rule prefix. Concepts first, then the main flows, then UI and settings. %%

## Not built yet

%% The notes marked realized: false. %%
`;

/** The form's text, exactly as typed. Add model folder has no form, so its description and purpose are empty. */
export interface TemplateFields {
	name: string;
	description: string;
	purpose: string;
}

const PLACEHOLDER = /\{\{(name|description|purpose)\}\}/g;

function isEmpty(value: string): boolean {
	return value.trim() === "";
}

/**
 * Replaces `{{name}}`, `{{description}}` and `{{purpose}}` with the fields as typed. A line that holds only a
 * placeholder whose field is empty is left out, with the blank line after it. Every other line stays as it is,
 * including unknown placeholders and `%%` comments.
 */
export function fillTemplate(template: string, fields: TemplateFields): string {
	const lines = template.split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const only = /^\s*\{\{(name|description|purpose)\}\}\s*$/.exec(lines[i]);
		if (only && isEmpty(fields[only[1] as keyof TemplateFields])) {
			if (i + 1 < lines.length - 1 && lines[i + 1].trim() === "") i++;
			continue;
		}
		out.push(lines[i].replace(PLACEHOLDER, (_, key: keyof TemplateFields) => fields[key]));
	}
	return out.join("\n");
}

/** The built-in index.md, for when its template is missing or blank. */
export function builtInIndex(fields: TemplateFields): string {
	const parts = [fields.description, fields.purpose].filter((part) => !isEmpty(part));
	const body = parts.length > 0 ? parts.join("\n\n") : `Manifesting ${fields.name}`;
	return `## What this repository is\n\n${body}\n`;
}

/** The template's text, found ignoring case, or null when it is missing. */
async function readTemplate(vaultPath: string, name: string): Promise<string | null> {
	const folders = await readdir(vaultPath).catch(() => [] as string[]);
	const folder = folders.find((entry) => entry.toLowerCase() === TEMPLATES_FOLDER.toLowerCase());
	if (!folder) return null;
	const files = await readdir(join(vaultPath, folder)).catch(() => [] as string[]);
	const file = files.find((entry) => entry.toLowerCase() === name);
	if (!file) return null;
	return readFile(join(vaultPath, folder, file), "utf8").catch(() => null);
}

/**
 * A new model folder's index.md and instructions.md, each from its template as it is now. A template that is
 * missing or holds only whitespace gives the built-in text instead, so creating a repository never fails because of one.
 */
export async function modelFolderTexts(vaultPath: string, fields: TemplateFields): Promise<{ index: string; instructions: string }> {
	const index = await readTemplate(vaultPath, "index.md");
	const instructions = await readTemplate(vaultPath, "instructions.md");
	return {
		index: index && !isEmpty(index) ? fillTemplate(index, fields) : builtInIndex(fields),
		instructions: instructions && !isEmpty(instructions) ? fillTemplate(instructions, fields) : MODEL_INSTRUCTIONS,
	};
}
