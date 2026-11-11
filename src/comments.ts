import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { findAnchor } from "./anchor";
import { commit, git, type Identity } from "./vault";

/** The dot folder a model folder keeps its comments in (CMNT-9). */
export const COMMENTS_FOLDER = ".comments";

export interface CommentAnchor {
	/** The nearest heading above the quote, as written, without its `#`. */
	heading?: string;
	quote: string;
}

export interface NoteComment {
	id: string;
	author: Identity;
	/** UTC, ISO 8601. */
	at: string;
	text: string;
}

export interface Thread {
	id: string;
	anchor: CommentAnchor;
	/** In the order they were written; the first one opened the thread. */
	comments: NoteComment[];
	resolved: { by: Identity; at: string } | null;
}

/** One note's comments, as saved in its comment file (CMNT-10). */
export interface CommentFile {
	version: 1;
	note: string;
	threads: Thread[];
}

export type ReadComments = { kind: "none" } | { kind: "ok"; file: CommentFile } | { kind: "broken" };

/**
 * Where a note's comments are saved, relative to the vault: the `.comments/` folder of the note's model
 * folder, at the note's path inside it, with `.json` instead of `.md`. A note outside every model folder
 * uses `.comments/` at the vault root (CMNT-9).
 */
export function commentFilePath(notePath: string, modelFolders: string[]): string {
	const json = notePath.replace(/\.md$/i, "") + ".json";
	const slash = json.indexOf("/");
	const folder = slash === -1 ? null : json.slice(0, slash);
	if (folder !== null && modelFolders.includes(folder)) return `${folder}/${COMMENTS_FOLDER}/${json.slice(slash + 1)}`;
	return `${COMMENTS_FOLDER}/${json}`;
}

/** The note's name as commit messages use it: its file name without `.md`. */
export function noteName(notePath: string): string {
	return notePath.slice(notePath.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPerson(value: unknown): value is Identity {
	return isObject(value) && typeof value.name === "string" && typeof value.email === "string";
}

function isThread(value: unknown): value is Thread {
	if (!isObject(value) || typeof value.id !== "string" || !isObject(value.anchor)) return false;
	const { anchor, comments, resolved } = value;
	if (typeof anchor.quote !== "string" || (anchor.heading !== undefined && typeof anchor.heading !== "string")) return false;
	if (!Array.isArray(comments)) return false;
	const commentsOk = comments.every(
		(c) => isObject(c) && typeof c.id === "string" && isPerson(c.author) && typeof c.at === "string" && typeof c.text === "string",
	);
	const resolvedOk = resolved === null || (isObject(resolved) && isPerson(resolved.by) && typeof resolved.at === "string");
	return commentsOk && resolvedOk;
}

/** The comment file's text parsed, or null when it isn't a comment file this version can read. */
export function parseComments(text: string): CommentFile | null {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isObject(data) || data.version !== 1 || typeof data.note !== "string" || !Array.isArray(data.threads)) return null;
	return data.threads.every(isThread) ? (data as unknown as CommentFile) : null;
}

/** Two-space indents and a newline at the end, so a comment's diff reads well in git (CMNT-11). */
export function formatComments(file: CommentFile): string {
	return JSON.stringify(file, null, 2) + "\n";
}

/** Reads the comment file at `path` (relative to the vault). */
export async function readCommentFile(vaultPath: string, path: string): Promise<ReadComments> {
	const full = join(vaultPath, path);
	if (!existsSync(full)) return { kind: "none" };
	const file = parseComments(await readFile(full, "utf8").catch(() => ""));
	return file ? { kind: "ok", file } : { kind: "broken" };
}

/** A note's path without `.md`, as the Comments view names it: `obsidian-plugin/Compile` (CMNT-17). */
export function noteLabel(notePath: string): string {
	return notePath.replace(/\.md$/i, "");
}

/** What the Comments view says when a note's comment file can't be read (CMNT-12). */
export function unreadableMessage(notePath: string, path: string): string {
	return `The comments on ${noteLabel(notePath)} can't be read: ${path}.`;
}

/** The note a comment file belongs to: the reverse of `commentFilePath` (CMNT-9). */
export function notePathOf(commentPath: string, modelFolders: string[]): string | null {
	if (!commentPath.toLowerCase().endsWith(".json")) return null;
	const md = commentPath.replace(/\.json$/i, ".md");
	if (md.startsWith(`${COMMENTS_FOLDER}/`)) return md.slice(COMMENTS_FOLDER.length + 1);
	const slash = md.indexOf("/");
	const folder = md.slice(0, slash);
	if (slash !== -1 && modelFolders.includes(folder) && md.startsWith(`${folder}/${COMMENTS_FOLDER}/`)) {
		return `${folder}/${md.slice(folder.length + COMMENTS_FOLDER.length + 2)}`;
	}
	return null;
}

async function jsonFiles(vaultPath: string, folder: string): Promise<string[]> {
	const entries = await readdir(join(vaultPath, folder), { withFileTypes: true }).catch(() => []);
	const found: string[] = [];
	for (const entry of entries) {
		const path = `${folder}/${entry.name}`;
		if (entry.isDirectory()) found.push(...(await jsonFiles(vaultPath, path)));
		else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) found.push(path);
	}
	return found;
}

/** Every comment file in the vault, with the note it belongs to (CMNT-9, CMNT-16). */
export async function listCommentFiles(vaultPath: string, modelFolders: string[]): Promise<{ note: string; path: string }[]> {
	const folders = [COMMENTS_FOLDER, ...modelFolders.map((folder) => `${folder}/${COMMENTS_FOLDER}`)];
	const files: { note: string; path: string }[] = [];
	for (const folder of folders) {
		for (const path of await jsonFiles(vaultPath, folder)) {
			const note = notePathOf(path, modelFolders);
			if (note) files.push({ note, path });
		}
	}
	return files;
}

/** One note's threads in the Comments view, under the note's path (CMNT-17). */
export interface ThreadGroup {
	note: string;
	label: string;
	threads: PlacedThread[];
}

function newest(threads: PlacedThread[]): string {
	return threads
		.flatMap(({ thread }) => thread.comments.map((c) => c.at))
		.reduce((a, b) => (new Date(b).getTime() > new Date(a).getTime() ? b : a), "1970-01-01T00:00:00Z");
}

function grouped(groups: ThreadGroup[]): ThreadGroup[] {
	return groups
		.filter((group) => group.threads.length > 0)
		.map((group) => ({ group, at: new Date(newest(group.threads)).getTime() }))
		.sort((a, b) => b.at - a.at || a.group.label.localeCompare(b.group.label))
		.map(({ group }) => group);
}

/**
 * Every note's threads, grouped by note, the note with the newest comment first (CMNT-17). Open threads
 * follow the order their quotes appear in the note; resolved ones are grouped the same way (CMNT-19).
 * `text` is null when the note isn't in the vault, so every quote counts as changed.
 */
export function groupThreads(notes: { note: string; file: CommentFile; text: string | null }[]): {
	open: ThreadGroup[];
	resolved: ThreadGroup[];
} {
	const open: ThreadGroup[] = [];
	const resolved: ThreadGroup[] = [];
	for (const { note, file, text } of notes) {
		const ordered = orderThreads(file, text ?? "");
		open.push({ note, label: noteLabel(note), threads: ordered.open });
		resolved.push({
			note,
			label: noteLabel(note),
			threads: ordered.resolved.map((thread) => ({ thread, at: text === null ? null : quotePosition(text, thread.anchor.quote) })),
		});
	}
	return { open: grouped(open), resolved: grouped(resolved) };
}

function newId(taken: Set<string>): string {
	for (;;) {
		const id = randomBytes(6).toString("base64url").replace(/[-_]/g, "").toLowerCase().slice(0, 6);
		if (id.length === 6 && !taken.has(id)) return id;
	}
}

export type CommentAction =
	| { kind: "comment"; anchor: CommentAnchor; text: string }
	| { kind: "reply"; threadId: string; text: string }
	| { kind: "resolve"; threadId: string }
	| { kind: "reopen"; threadId: string };

const MESSAGES: Record<CommentAction["kind"], string> = {
	comment: "Comment on",
	reply: "Reply on",
	resolve: "Resolve a comment on",
	reopen: "Reopen a comment on",
};

/** The commit message for an action on a note (CMNT-13). */
export function commentMessage(action: CommentAction["kind"], notePath: string): string {
	return `${MESSAGES[action]} ${noteName(notePath)}`;
}

/** The file with the action applied. Never changes `file`. Throws when the thread is gone. */
export function applyAction(file: CommentFile, action: CommentAction, author: Identity, now: Date): CommentFile {
	const next: CommentFile = structuredClone(file);
	const at = now.toISOString();
	const taken = new Set(next.threads.flatMap((t) => [t.id, ...t.comments.map((c) => c.id)]));
	if (action.kind === "comment") {
		const id = newId(taken);
		taken.add(id);
		next.threads.push({
			id,
			anchor: action.anchor,
			comments: [{ id: newId(taken), author, at, text: action.text }],
			resolved: null,
		});
		return next;
	}
	const thread = next.threads.find((t) => t.id === action.threadId);
	if (!thread) throw new Error("This comment isn't there any more. Someone may have changed it.");
	if (action.kind === "reply") thread.comments.push({ id: newId(taken), author, at, text: action.text });
	else if (action.kind === "resolve") thread.resolved = { by: author, at };
	else thread.resolved = null;
	return next;
}

export interface CommentResult {
	file: CommentFile;
	/** The comment file, relative to the vault. */
	path: string;
	/** Why the commit failed, or null when it was made (CMNT-14). */
	notCommitted: string | null;
}

/**
 * Applies the action to the note's comment file, writes it, and commits only that file, signed by the
 * author (CMNT-13). A file that can't be read is never overwritten (CMNT-12). When the commit fails the
 * comment stays saved, and the next commit of the file takes it along (CMNT-14).
 */
export async function saveComment(
	vaultPath: string,
	notePath: string,
	modelFolders: string[],
	action: CommentAction,
	author: Identity,
	now = new Date(),
): Promise<CommentResult> {
	const path = commentFilePath(notePath, modelFolders);
	const read = await readCommentFile(vaultPath, path);
	if (read.kind === "broken") throw new Error(unreadableMessage(notePath, path));
	const current: CommentFile = read.kind === "ok" ? read.file : { version: 1, note: notePath, threads: [] };
	const file = applyAction(current, action, author, now);
	await mkdir(dirname(join(vaultPath, path)), { recursive: true });
	await writeFile(join(vaultPath, path), formatComments(file));
	let notCommitted: string | null = null;
	try {
		await commit(vaultPath, commentMessage(action.kind, notePath), [path]);
	} catch (error) {
		notCommitted = error instanceof Error ? error.message : String(error);
	}
	return { file, path, notCommitted };
}

async function isTracked(vaultPath: string, path: string): Promise<boolean> {
	const { stdout } = await git(vaultPath, ["ls-files", "--", path]).catch(() => ({ stdout: "" }));
	return stdout.trim() !== "";
}

/**
 * Moves a note's comment file to match the note's new path, and commits the move at once as "Move
 * comments on {note name}" (CMNT-15). The file's `note` is updated; a file that can't be read is moved
 * as it is. Returns false when the note had no comments.
 */
export async function moveComments(vaultPath: string, oldNote: string, newNote: string, modelFolders: string[]): Promise<boolean> {
	const from = commentFilePath(oldNote, modelFolders);
	const to = commentFilePath(newNote, modelFolders);
	if (!existsSync(join(vaultPath, from))) return false;
	if (from !== to && existsSync(join(vaultPath, to))) {
		throw new Error(`${to} already exists, so the comments on ${noteName(oldNote)} stay in ${from}.`);
	}
	const read = await readCommentFile(vaultPath, from);
	await mkdir(dirname(join(vaultPath, to)), { recursive: true });
	if (read.kind === "ok") {
		await writeFile(join(vaultPath, to), formatComments({ ...read.file, note: newNote }));
		if (from !== to) await rm(join(vaultPath, from));
	} else if (from !== to) {
		await rename(join(vaultPath, from), join(vaultPath, to));
	}
	const paths = [to];
	if (from !== to && (await isTracked(vaultPath, from))) paths.push(from);
	await commit(vaultPath, `Move comments on ${noteName(newNote)}`, paths);
	return true;
}

/**
 * Deletes a deleted note's comment file and commits it as "Delete comments on {note name}". Earlier
 * comments stay in git history (CMNT-15). Returns false when the note had no comments.
 */
export async function deleteComments(vaultPath: string, notePath: string, modelFolders: string[]): Promise<boolean> {
	const path = commentFilePath(notePath, modelFolders);
	if (!existsSync(join(vaultPath, path))) return false;
	const tracked = await isTracked(vaultPath, path);
	await rm(join(vaultPath, path));
	if (tracked) await commit(vaultPath, `Delete comments on ${noteName(notePath)}`, [path]);
	return true;
}

/** Where a thread sits in the note: its quote's place, or null when the quote is no longer there (CMNT-20). */
export function quotePosition(noteText: string, quote: string): { from: number; to: number } | null {
	return quote.trim() ? findAnchor(noteText, { path: "", quote }) : null;
}

export interface PlacedThread {
	thread: Thread;
	/** Null when the text it was on has changed (CMNT-20). */
	at: { from: number; to: number } | null;
}

/**
 * Open threads in the order their quotes appear in the note, then those whose quote is gone; and the
 * resolved threads, in the order they were written (CMNT-17, CMNT-19).
 */
export function orderThreads(file: CommentFile, noteText: string): { open: PlacedThread[]; resolved: Thread[] } {
	const open = file.threads
		.filter((thread) => thread.resolved === null)
		.map((thread) => ({ thread, at: quotePosition(noteText, thread.anchor.quote) }));
	const placed = open.filter((t) => t.at !== null).sort((a, b) => a.at!.from - b.at!.from);
	const changed = open.filter((t) => t.at === null);
	return { open: [...placed, ...changed], resolved: file.threads.filter((thread) => thread.resolved !== null) };
}

/** The end of the note's front matter, or 0 when it has none. Text before it is the properties block (CMNT-4). */
export function frontMatterEnd(text: string): number {
	const match = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
	return match ? match[0].length : 0;
}

/** The nearest heading above `offset`, without its `#`, outside code blocks (CMNT-7). */
export function headingAbove(text: string, offset: number): string | undefined {
	let heading: string | undefined;
	let fence: string | null = null;
	let position = 0;
	for (const line of text.split("\n")) {
		if (position > offset) break;
		const opened = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
		if (fence !== null) {
			if (opened && opened[1][0] === fence[0] && line.trim() === opened[1]) fence = null;
		} else if (opened) {
			fence = opened[1];
		} else {
			const match = /^#{1,6}[ \t]+(.*?)[ \t#]*$/.exec(line);
			if (match) heading = match[1].trim();
		}
		position += line.length + 1;
	}
	return heading || undefined;
}

/** The anchor of a comment on `quote`, selected at `offset` in the note (CMNT-7). */
export function commentAnchor(noteText: string, offset: number, quote: string): CommentAnchor {
	const heading = headingAbove(noteText, offset);
	return heading ? { heading, quote: quote.trim() } : { quote: quote.trim() };
}
