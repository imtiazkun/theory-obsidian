import { ChildProcess, spawn } from "child_process";
import { existsSync } from "fs";
import { readFile, readdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { CompileEffort, CompileModel } from "./compile";
import { toolPath } from "./tool-path";

/** Claude returns at most this many suggestions (EXP-8). */
export const MAX_EXPAND_SUGGESTIONS = 10;

/** A note Claude thinks the model folder is missing. Shown on screen only; never saved, never written to a note. */
export interface ExpandSuggestion {
	name: string;
	/** The question the note must answer. */
	question: string;
	/** The line of the index, or the file of code, that calls for it. */
	why: string;
	headings: string[];
}

export interface NoteText {
	/** Vault-relative path. */
	path: string;
	text: string;
}

/** Everything Expand sends Claude about the model (EXP-4, EXP-5). */
export interface ExpandContext {
	/** The model folder's name, which is also the repository's. */
	repo: string;
	index: NoteText | null;
	instructions: NoteText | null;
	/** Every other note in the model folder. */
	notes: NoteText[];
	rootIndex: NoteText | null;
	/** The names of all notes in the model folder, without `.md`. */
	names: string[];
}

/** Folders and notes whose name starts with `_` or `.` are never sent. */
function isHidden(name: string): boolean {
	return name.startsWith("_") || name.startsWith(".");
}

/** Every note in `folder` (vault-relative), outside hidden folders and without hidden notes, sorted. */
async function notesIn(vaultPath: string, folder: string): Promise<string[]> {
	const entries = await readdir(join(vaultPath, folder), { withFileTypes: true }).catch(() => []);
	const paths: string[] = [];
	for (const entry of entries) {
		const path = `${folder}/${entry.name}`;
		if (entry.isDirectory()) {
			if (!isHidden(entry.name)) paths.push(...(await notesIn(vaultPath, path)));
		} else if (entry.isFile() && !isHidden(entry.name) && entry.name.toLowerCase().endsWith(".md")) {
			paths.push(path);
		}
	}
	return paths.sort();
}

function noteName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}

/** Reads the context as the notes are now, uncommitted edits included. Expand compiles nothing. */
export async function expandContext(vaultPath: string, repo: string): Promise<ExpandContext> {
	const read = async (path: string): Promise<NoteText> => ({ path, text: await readFile(join(vaultPath, path), "utf8") });
	const paths = await notesIn(vaultPath, repo);
	const direct = (name: string) => paths.find((path) => path.toLowerCase() === `${repo}/${name}`.toLowerCase());
	const indexPath = direct("index.md");
	const instructionsPath = direct("instructions.md");
	const others = paths.filter((path) => path !== indexPath && path !== instructionsPath);

	// Only the root Index; the root Instructions stays human-only.
	const rootEntries = await readdir(vaultPath, { withFileTypes: true }).catch(() => []);
	const rootIndex = rootEntries.find((entry) => entry.isFile() && entry.name.toLowerCase() === "index.md");

	return {
		repo,
		index: indexPath ? await read(indexPath) : null,
		instructions: instructionsPath ? await read(instructionsPath) : null,
		notes: await Promise.all(others.map(read)),
		rootIndex: rootIndex ? await read(rootIndex.name) : null,
		names: paths.map(noteName),
	};
}

function noteBlock(note: NoteText | null, missing: string): string {
	return note ? `### ${note.path}\n\n${note.text}` : missing;
}

/** The whole prompt: what Expand is for, the rules for suggestions, and the context. */
export function buildExpandPrompt(context: ExpandContext, canReadCode: boolean): string {
	const { repo } = context;
	const code = canReadCode
		? `You may read the code of the repository "${repo}" with Read, Glob and Grep. You are in it now. Read nothing outside it. Code that no note describes is the most useful gap you can find.`
		: `The repository "${repo}" doesn't exist yet. You have no tools; everything you may use is below.`;
	const others = context.notes.map((note) => noteBlock(note, "")).join("\n\n");
	return `An engineer writes a theoretical model of a software system as notes. Each repository has a model folder of notes, with an index.md that lists them. Suggest which notes the model folder "${repo}" is missing before its code can be built.

You only suggest. The engineer decides which notes exist and writes every word in them.

${code}

Rules:
- Suggest at most ${MAX_EXPAND_SUGGESTIONS} notes.
- Only suggest a note that the index or the code calls for, and name the line of the index or the file of code in "why".
- Never suggest a feature the index doesn't mention.
- Never suggest a note that already exists in the model folder. Their names are listed below.
- Give each note two or three headings it might have.

Reply with only a JSON object, no other text: {"notes": [{"name": "<note name>", "question": "<the question the note must answer>", "why": "<the line of the index or the file of code that calls for it>", "headings": ["<heading>", "<heading>"]}]}. When nothing is missing, reply {"notes": []}.

## Notes in the model folder

${context.names.map((name) => `- ${name}`).join("\n") || "(none)"}

## The model folder's index.md

${noteBlock(context.index, "(This model folder has no index.md.)")}

## The model folder's instructions.md

${noteBlock(context.instructions, "(This model folder has no instructions.md.)")}

## The other notes in the model folder, as they are now

${others || "(none)"}

## The root Index.md

${noteBlock(context.rootIndex, "(The vault has no root Index.md.)")}
`;
}

export interface ExpandArgsOptions {
	model: CompileModel;
	effort: CompileEffort;
	/** The repository in the project folder, or null when it doesn't exist there. */
	repoPath: string | null;
}

/** Arguments and working folder for Claude Code. It may only read the repository's code, and only when it exists (EXP-6). */
export function expandCommand(options: ExpandArgsOptions): { args: string[]; cwd: string } {
	const args = ["-p", "--output-format", "json", "--strict-mcp-config", "--no-session-persistence"];
	const { repoPath } = options;
	if (repoPath) {
		const inside = `//${repoPath.replace(/^\//, "")}/**`;
		// Read rules also cover Glob and Grep. Anything not allowed here is denied without asking.
		args.push("--tools", "Read,Glob,Grep", "--permission-mode", "dontAsk", "--allowedTools", `Read(${inside})`);
	} else {
		args.push("--tools", "");
	}
	if (options.model) args.push("--model", options.model);
	if (options.effort) args.push("--effort", options.effort);
	return { args, cwd: repoPath ?? tmpdir() };
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Pulls the suggestions out of Claude's reply. Drops notes that already exist and keeps at most ten. */
export function parseExpandReply(text: string, existing: string[]): ExpandSuggestion[] {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error("Claude didn't reply with suggestions.");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		throw new Error("Claude's reply couldn't be read.");
	}
	const notes = (parsed as { notes?: unknown } | null)?.notes;
	if (!Array.isArray(notes)) throw new Error("Claude's reply had no list of notes.");
	const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
	const result: ExpandSuggestion[] = [];
	for (const note of notes) {
		const item = (note ?? {}) as Record<string, unknown>;
		const name = str(item.name).replace(/\.md$/i, "");
		if (!name || existing.some((other) => sameName(other, name)) || result.some((s) => sameName(s.name, name))) continue;
		const headings = Array.isArray(item.headings) ? item.headings.map(str).filter(Boolean) : [];
		result.push({ name, question: str(item.question), why: str(item.why), headings });
	}
	return result.slice(0, MAX_EXPAND_SUGGESTIONS);
}

/** The card as plain text, for Copy. */
export function suggestionText(s: ExpandSuggestion): string {
	const lines = [s.name, "", s.question];
	if (s.headings.length > 0) lines.push("", ...s.headings.map((heading) => `## ${heading}`));
	return lines.join("\n");
}

export interface ExpandOptions extends ExpandArgsOptions {
	claudeCommand: string;
	vaultPath: string;
	repo: string;
}

export interface ExpandRun {
	done: Promise<ExpandSuggestion[]>;
	cancel(): void;
}

/** Asks Claude Code which notes the model folder is missing. Claude can write, edit and run nothing. */
export function startExpand(options: ExpandOptions): ExpandRun {
	let child: ChildProcess | null = null;
	let cancelled = false;
	const done = (async () => {
		const context = await expandContext(options.vaultPath, options.repo);
		const repoPath = options.repoPath && existsSync(options.repoPath) ? options.repoPath : null;
		const { args, cwd } = expandCommand({ ...options, repoPath });
		const prompt = buildExpandPrompt(context, repoPath !== null);
		if (cancelled) throw new Error("cancelled");
		return new Promise<ExpandSuggestion[]>((resolve, reject) => {
			try {
				child = spawn(options.claudeCommand || "claude", args, { cwd, env: { ...process.env, PATH: toolPath() } });
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
					resolve(parseExpandReply(text, context.names));
				} catch (error) {
					reject(error);
				}
			});
			// Keeps the prompt out of the argument list, which has a size limit.
			child.stdin?.end(prompt);
		});
	})();
	return {
		done,
		cancel() {
			cancelled = true;
			(child as ChildProcess | null)?.kill("SIGTERM");
		},
	};
}

/** The note name the engineer typed, or the reason it can't be used. */
export function noteNameProblem(name: string): string | null {
	if (!name) return "Type a name for the note.";
	if (/[\\/:]/.test(name)) return "A note name can't contain / \\ or :.";
	if (name.startsWith(".") || name.startsWith("_")) return "A note name can't start with . or _.";
	return null;
}

/**
 * Creates an empty note named `name` in the model folder and returns its vault path. The body stays empty:
 * no suggested question or heading is written into it. It never commits (EXP-14 to EXP-16).
 * Throws "{name} already exists." when a note with that name is anywhere in the model folder.
 */
export async function createEmptyNote(
	vaultPath: string,
	repo: string,
	typed: string,
	create: (path: string) => Promise<unknown> = (path) => writeFile(join(vaultPath, path), "", { flag: "wx" }),
): Promise<string> {
	const name = typed.trim().replace(/\.md$/i, "");
	const problem = noteNameProblem(name);
	if (problem) throw new Error(problem);
	const existing = (await notesIn(vaultPath, repo)).map(noteName);
	if (existing.some((other) => sameName(other, name))) throw new Error(`${name} already exists.`);
	const path = `${repo}/${name}.md`;
	await create(path);
	return path;
}

/**
 * The repository whose Expand button shows for the active note: the note must be `index.md` (any case)
 * directly inside a model folder, named exactly like a repository. Null for any other note, the root Index included.
 */
export function expandRepoFor(path: string | null | undefined, repos: string[]): string | null {
	if (!path) return null;
	const slash = path.indexOf("/");
	if (slash < 0 || path.indexOf("/", slash + 1) >= 0) return null;
	const folder = path.slice(0, slash);
	return repos.includes(folder) && path.slice(slash + 1).toLowerCase() === "index.md" ? folder : null;
}
