import { ChildProcess, spawn } from "child_process";
import { readFile, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join, posix } from "path";
import type { CompileEffort, CompileModel } from "./compile";
import { TOOL_PATH } from "./vault";

/** Claude returns at most this many suggestions. A short list gets read; a long one gets accepted without thought. */
export const MAX_SUGGESTIONS = 10;
const MAX_HEADINGS = 3;

/** A note Claude thinks the model folder is missing. It lives only on screen and is never model text. */
export interface ExpandSuggestion {
	name: string;
	/** The question the note must answer. */
	question: string;
	/** Why it is needed: the line of the index, or the file of code, that calls for it. */
	reason: string;
	headings: string[];
}

export interface ExpandNote {
	/** Relative to the vault root. */
	path: string;
	text: string;
}

/** Everything Expand sends Claude, and nothing else (EXP-4). */
export interface ExpandContext {
	folder: string;
	index: ExpandNote | null;
	instructions: ExpandNote | null;
	/** Every other note in the model folder, as it is now. */
	notes: ExpandNote[];
	/** The root Index.md. The root Instructions is never sent. */
	rootIndex: ExpandNote | null;
	/** The paths of all notes in the model folder. */
	names: string[];
}

/** Hidden folders (name starts with `_`) and dot folders like `.obsidian` are never sent. */
function isSkippedFolder(name: string): boolean {
	return name.startsWith("_") || name.startsWith(".");
}

/** Markdown notes under `dir` (relative to the vault), skipping hidden and dot folders, sorted by path. */
async function notesIn(vaultPath: string, dir: string): Promise<string[]> {
	const entries = await readdir(join(vaultPath, dir), { withFileTypes: true }).catch(() => []);
	const found: string[] = [];
	for (const entry of entries) {
		const path = posix.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!isSkippedFolder(entry.name)) found.push(...(await notesIn(vaultPath, path)));
		} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
			found.push(path);
		}
	}
	return found.sort();
}

async function readNote(vaultPath: string, path: string): Promise<ExpandNote | null> {
	const text = await readFile(join(vaultPath, path), "utf8").catch(() => null);
	return text === null ? null : { path, text };
}

/**
 * Reads the context for one model folder from disk, uncommitted edits included: Expand compiles nothing,
 * and the engineer asks about the index as it stands.
 */
export async function readExpandContext(vaultPath: string, folder: string): Promise<ExpandContext> {
	const names = await notesIn(vaultPath, folder);
	const top = (name: string) => names.find((path) => path.toLowerCase() === `${folder}/${name}`.toLowerCase());
	const indexPath = top("index.md");
	const instructionsPath = top("instructions.md");
	const notes: ExpandNote[] = [];
	for (const path of names) {
		if (path === indexPath || path === instructionsPath) continue;
		const note = await readNote(vaultPath, path);
		if (note) notes.push(note);
	}
	const rootEntries = await readdir(vaultPath).catch(() => [] as string[]);
	const rootIndex = rootEntries.find((name) => name.toLowerCase() === "index.md");
	return {
		folder,
		index: indexPath ? await readNote(vaultPath, indexPath) : null,
		instructions: instructionsPath ? await readNote(vaultPath, instructionsPath) : null,
		notes,
		rootIndex: rootIndex ? await readNote(vaultPath, rootIndex) : null,
		names,
	};
}

/** The model folder whose `index.md` this is, or null. The root Index.md and deeper index files don't count. */
export function modelFolderOfIndex(path: string, repoNames: string[]): string | null {
	const parts = path.split("/");
	if (parts.length !== 2 || parts[1].toLowerCase() !== "index.md") return null;
	return repoNames.includes(parts[0]) ? parts[0] : null;
}

/** A path as a Claude Code permission rule path: `//` followed by the absolute path. */
function rulePath(path: string): string {
	return `//${path.replace(/^\/+/, "").replace(/\/+$/, "")}/**`;
}

/**
 * Claude Code's arguments and working folder. With the repository's code, Claude may only Read, Glob and Grep inside
 * that repository. Without it, Claude gets no tools. It can never write, edit or run anything.
 */
export function expandCommand(options: {
	model: CompileModel;
	effort: CompileEffort;
	vaultPath: string;
	repoPath: string | null;
}): { args: string[]; cwd: string } {
	const args = ["-p", "--output-format", "json", "--strict-mcp-config", "--no-session-persistence"];
	if (options.repoPath) {
		args.push(
			"--tools",
			"Read,Glob,Grep",
			"--permission-mode",
			"default",
			// Read rules cover Glob and Grep too.
			"--allowedTools",
			`Read(${rulePath(options.repoPath)})`,
			"--disallowedTools",
			`Read(${rulePath(options.vaultPath)})`,
		);
	} else {
		args.push("--tools", "");
	}
	if (options.model) args.push("--model", options.model);
	if (options.effort) args.push("--effort", options.effort);
	return { args, cwd: options.repoPath ?? tmpdir() };
}

function noteBlock(note: ExpandNote | null, missing: string): string {
	return note ? `### ${note.path}\n\n${note.text}` : missing;
}

export function buildExpandPrompt(context: ExpandContext, hasCode: boolean): string {
	const others = context.notes.map((note) => noteBlock(note, "")).join("\n\n");
	return `An engineer writes a theoretical model of a software system as notes. Each repository has a folder of notes; its index.md lists what that repository is and which notes describe it. Find the notes the model folder "${context.folder}" is missing before its code can be built.

You only suggest. The engineer decides which notes exist and writes every word in them.

Rules:
- Suggest at most ${MAX_SUGGESTIONS} notes.
- Suggest only notes that the index or the code calls for, and name the line of the index or the file of code that calls for it.
- Never suggest a feature the index doesn't mention.
- Never suggest a note that already exists in the model folder. The existing notes are listed below.
- ${hasCode ? `You may read the repository's code in the current directory with Read, Glob and Grep, and nothing else. Code that no note describes is the most useful gap to find.` : "You have no tools. Everything you may use is below."}

Reply with only a JSON object, no other text: {"suggestions": [{"name": "<note name>", "question": "<the question the note must answer>", "reason": "<why: the line of the index or the file of code that calls for it>", "headings": ["<two or three headings it might have>"]}]}. When nothing is missing, reply {"suggestions": []}.

## ${context.folder}/index.md

${context.index ? context.index.text : "(This model folder has no index.md.)"}

## ${context.folder}/instructions.md

${context.instructions ? context.instructions.text : "(This model folder has no instructions.md.)"}

## The root Index.md

${context.rootIndex ? context.rootIndex.text : "(The vault has no Index.md.)"}

## Notes in the model folder

${context.names.map((name) => `- ${name}`).join("\n") || "(none)"}

## The other notes, as they are now

${others || "(none)"}
`;
}

/** A note name without a `.md` ending or surrounding space. */
export function noteName(name: string): string {
	return name.trim().replace(/\.md$/i, "").trim();
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()) : [];
}

/** Pulls the suggestions out of Claude's reply, leaving out notes that already exist, at most ten. */
export function parseSuggestions(text: string, existing: string[]): ExpandSuggestion[] {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error("Claude didn't reply with suggestions.");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		throw new Error("Claude's reply couldn't be read.");
	}
	const list = (parsed as { suggestions?: unknown } | null)?.suggestions;
	if (!Array.isArray(list)) throw new Error("Claude's reply had no suggestions.");
	const taken = new Set(existing.map((path) => noteName(posix.basename(path)).toLowerCase()));
	const suggestions: ExpandSuggestion[] = [];
	for (const item of list) {
		const { name, question, reason, headings } = (item ?? {}) as Record<string, unknown>;
		if (typeof name !== "string" || !noteName(name)) continue;
		const clean = noteName(name);
		if (taken.has(clean.toLowerCase())) continue;
		taken.add(clean.toLowerCase());
		suggestions.push({
			name: clean,
			question: typeof question === "string" ? question.trim() : "",
			reason: typeof reason === "string" ? reason.trim() : "",
			headings: strings(headings).slice(0, MAX_HEADINGS),
		});
		if (suggestions.length === MAX_SUGGESTIONS) break;
	}
	return suggestions;
}

/** The card's name, question and headings as plain text, for Copy. */
export function suggestionText(s: ExpandSuggestion): string {
	return [s.name, "", s.question, "", ...s.headings.map((h) => `- ${h}`)].join("\n").trim() + "\n";
}

export interface ExpandOptions {
	claudeCommand: string;
	model: CompileModel;
	effort: CompileEffort;
	vaultPath: string;
	/** The repository in the project folder, or null when it doesn't exist there yet. */
	repoPath: string | null;
	context: ExpandContext;
}

export interface ExpandRun {
	done: Promise<ExpandSuggestion[]>;
	cancel(): void;
}

/** Asks Claude Code which notes the model folder is missing. Claude can only read; it never writes. */
export function startExpand(options: ExpandOptions): ExpandRun {
	const { args, cwd } = expandCommand(options);
	let child: ChildProcess | null = null;
	let cancelled = false;
	const done = new Promise<ExpandSuggestion[]>((resolve, reject) => {
		try {
			child = spawn(options.claudeCommand || "claude", args, { cwd, env: { ...process.env, PATH: TOOL_PATH } });
		} catch (error) {
			reject(error);
			return;
		}
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => (stdout += chunk));
		child.stderr?.on("data", (chunk) => (stderr += chunk));
		child.stdin?.on("error", () => {});
		child.on("error", (error) => {
			reject(
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? new Error(`couldn't find the Claude Code CLI ("${options.claudeCommand}")`)
					: error,
			);
		});
		child.on("close", (code) => {
			if (cancelled) return reject(new Error("cancelled"));
			let result: { is_error?: boolean; result?: unknown } | null = null;
			try {
				result = JSON.parse(stdout);
			} catch {
				// Handled below.
			}
			const text = typeof result?.result === "string" ? result.result : "";
			if (!result || result.is_error) {
				return reject(new Error(text || stderr.trim() || `Claude Code exited with code ${code}`));
			}
			try {
				resolve(parseSuggestions(text, options.context.names));
			} catch (error) {
				reject(error);
			}
		});
		// Keeps the prompt out of the argument list, which has a size limit.
		child.stdin?.end(buildExpandPrompt(options.context, options.repoPath !== null));
	});
	return {
		done,
		cancel() {
			cancelled = true;
			child?.kill("SIGTERM");
		},
	};
}

/** Where Create note writes, and what is already there. Obsidian's vault in the app, a temporary folder in tests. */
export interface NoteVault {
	/** Every file path in the vault, relative to its root. */
	files(): string[];
	create(path: string, text: string): Promise<unknown>;
}

export type CreatedNote = { created: true; path: string } | { created: false; reason: string };

/**
 * Create note: an empty note with the name the engineer confirmed, in the model folder. The suggested question and
 * headings are never written into it, and it is never committed.
 */
export async function createExpandNote(vault: NoteVault, folder: string, name: string): Promise<CreatedNote> {
	const clean = noteName(name);
	if (!clean) return { created: false, reason: "Type a name for the note." };
	if (/[\\/]/.test(clean)) return { created: false, reason: "A note name can't contain / or \\." };
	const path = `${folder}/${clean}.md`;
	const taken = vault
		.files()
		.filter((file) => file.startsWith(`${folder}/`) && file.toLowerCase().endsWith(".md"))
		.some((file) => noteName(posix.basename(file)).toLowerCase() === clean.toLowerCase());
	if (taken) return { created: false, reason: `${clean} already exists.` };
	await vault.create(path, "");
	return { created: true, path };
}
