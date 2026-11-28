import { git } from "./vault";

/** One line of a file's diff: kept, removed or added. */
export interface DiffLine {
	kind: " " | "-" | "+";
	text: string;
	/** Git's "\ No newline at end of file" follows this line. */
	noNewline?: boolean;
}

/** One file of the model diff, read with the whole file as context, so every line of both sides is in `lines`. */
export interface DiffFile {
	/** The lines before the hunk: `diff --git`, modes, `index`, `---` and `+++`. */
	header: string[];
	/** The path before the change, or null for a new file. */
	oldPath: string | null;
	/** The path after the change, or null for a deleted file. */
	newPath: string | null;
	/** Empty for a binary file, or one whose content didn't change (a rename, a mode change). */
	lines: DiffLine[];
}

/** The model diff of a compile: git's summary of changed files, and each file in full. */
export interface ModelChanges {
	stat: string;
	files: DiffFile[];
}

/** Context large enough that every file's diff is one hunk holding the whole file. */
const WHOLE_FILE = 100_000_000;

/** A path from a `---`/`+++` line or the `diff --git` line: without its `a/` or `b/`, quotes or git's trailing tab. */
function cleanPath(raw: string): string {
	let path = raw.replace(/\t$/, "");
	if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
	return path.replace(/^[ab]\//, "");
}

/** Splits the output of `git diff --stat --patch -U<whole file>` into the summary and its files. */
export function parseModelDiff(output: string): ModelChanges {
	const lines = output.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	const first = lines.findIndex((line) => line.startsWith("diff --git "));
	const statLines = first === -1 ? lines : lines.slice(0, first);
	const stat = statLines.join("\n").trimEnd();
	const files: DiffFile[] = [];
	let i = first === -1 ? lines.length : first;
	while (i < lines.length) {
		const header: string[] = [lines[i++]];
		while (i < lines.length && !lines[i].startsWith("diff --git ") && !lines[i].startsWith("@@ ")) header.push(lines[i++]);
		const file: DiffFile = { header, oldPath: null, newPath: null, lines: [] };
		let sawOld = false;
		let sawNew = false;
		for (const line of header) {
			if (line.startsWith("--- ")) {
				sawOld = true;
				file.oldPath = line === "--- /dev/null" ? null : cleanPath(line.slice(4));
			} else if (line.startsWith("+++ ")) {
				sawNew = true;
				file.newPath = line === "+++ /dev/null" ? null : cleanPath(line.slice(4));
			} else if (line.startsWith("rename from ")) {
				sawOld = true;
				file.oldPath = line.slice("rename from ".length);
			} else if (line.startsWith("rename to ")) {
				sawNew = true;
				file.newPath = line.slice("rename to ".length);
			}
		}
		if (!sawOld || !sawNew) {
			// A binary or unchanged file has no `---`/`+++`: its path is both halves of `diff --git a/{path} b/{path}`.
			const both = header[0].slice("diff --git ".length);
			const path = cleanPath(both.slice(0, Math.floor((both.length - 1) / 2)));
			const added = header.some((line) => line.startsWith("new file mode"));
			const deleted = header.some((line) => line.startsWith("deleted file mode"));
			if (!sawOld) file.oldPath = added ? null : path;
			if (!sawNew) file.newPath = deleted ? null : path;
		}
		const hunk = i < lines.length ? /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(lines[i]) : null;
		if (hunk) {
			i++;
			let oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
			let newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
			while (i < lines.length && (oldLeft > 0 || newLeft > 0 || lines[i].startsWith("\\"))) {
				const line = lines[i++];
				const kind = line[0];
				if (kind === "\\") {
					const last = file.lines[file.lines.length - 1];
					if (last) last.noNewline = true;
					continue;
				}
				const text = line.slice(1);
				if (kind === "-") {
					file.lines.push({ kind: "-", text });
					oldLeft--;
				} else if (kind === "+") {
					file.lines.push({ kind: "+", text });
					newLeft--;
				} else {
					file.lines.push({ kind: " ", text });
					oldLeft--;
					newLeft--;
				}
			}
		}
		files.push(file);
	}
	return { stat, files };
}

/**
 * Reads the diff Claude receives (CMP-10): git's summary of changed files and every changed file in full, so the
 * diff can be shown with whole sections and the changed rules found (CMP-92). `pathspecs` keeps out what is never
 * sent (INV-13, UI-22).
 */
export async function readModelDiff(vaultPath: string, from: string, to: string, pathspecs: string[]): Promise<ModelChanges> {
	const { stdout } = await git(vaultPath, [
		"-c",
		"core.quotePath=false",
		"diff",
		"--no-color",
		"--no-ext-diff",
		"--stat",
		"--patch",
		`-U${WHOLE_FILE}`,
		from,
		to,
		"--",
		...pathspecs,
	]);
	return parseModelDiff(stdout);
}

/** True for a note: a Markdown file. */
export function isNote(path: string | null): boolean {
	return path !== null && path.toLowerCase().endsWith(".md");
}

const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/** The heading level of each line (0 for none), skipping front matter and fenced code. */
export function headingLevels(lines: string[]): number[] {
	const levels = lines.map(() => 0);
	let start = 0;
	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex((line, i) => i > 0 && (line.trim() === "---" || line.trim() === "..."));
		if (end > 0) start = end + 1;
	}
	let fence: string | null = null;
	for (let i = start; i < lines.length; i++) {
		const line = lines[i];
		const opened = FENCE.exec(line);
		if (fence !== null) {
			if (opened && opened[1][0] === fence[0] && opened[1].length >= fence.length && line.trim() === opened[1]) fence = null;
			continue;
		}
		if (opened) {
			fence = opened[1];
			continue;
		}
		const heading = /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(line);
		if (heading) levels[i] = heading[1].length;
	}
	return levels;
}

/** Each line's place on the old and new side of a file (from 0), or -1 on the side it isn't on. */
export function sides(file: DiffFile): { old: number[]; new: number[] } {
	const oldIndex: number[] = [];
	const newIndex: number[] = [];
	let o = 0;
	let n = 0;
	for (const line of file.lines) {
		oldIndex.push(line.kind === "+" ? -1 : o++);
		newIndex.push(line.kind === "-" ? -1 : n++);
	}
	return { old: oldIndex, new: newIndex };
}

/** The file before and after the change, as lines. */
export function fileSides(file: DiffFile): { old: string[]; new: string[] } {
	return {
		old: file.lines.filter((l) => l.kind !== "+").map((l) => l.text),
		new: file.lines.filter((l) => l.kind !== "-").map((l) => l.text),
	};
}

type Range = [start: number, end: number];

/** Ranges of `file.lines` (inclusive) holding each change with `context` lines around it. */
export function contextRanges(file: DiffFile, context: number): Range[] {
	const ranges: Range[] = [];
	file.lines.forEach((line, i) => {
		if (line.kind !== " ") ranges.push([Math.max(0, i - context), Math.min(file.lines.length - 1, i + context)]);
	});
	return merge(ranges);
}

/**
 * Ranges of `file.lines` (inclusive) holding each change with the whole section it sits in: from the heading above
 * it to the next heading of the same or a higher level (CMP-10). A change above every heading gets the lines up to
 * the first heading.
 */
export function sectionRanges(file: DiffFile): Range[] {
	const text = fileSides(file);
	const oldLevels = headingLevels(text.old);
	const newLevels = headingLevels(text.new);
	const at = sides(file);
	// A kept line is a heading on the new side; a removed or added line on its own side.
	const levels = file.lines.map((line, i) => (line.kind === "-" ? oldLevels[at.old[i]] : newLevels[at.new[i]]));
	const ranges: Range[] = [];
	file.lines.forEach((line, i) => {
		if (line.kind === " ") return;
		let start = i;
		while (start >= 0 && levels[start] === 0) start--;
		// Above every heading, the section ends at the first heading of any level.
		const level = start >= 0 ? levels[start] : 7;
		start = Math.max(start, 0);
		let end = start + 1;
		while (end < file.lines.length && !(levels[end] > 0 && levels[end] <= level)) end++;
		ranges.push([start, Math.max(i, end - 1)]);
	});
	return merge(ranges);
}

/** Sorts ranges and joins those that overlap or touch. */
function merge(ranges: Range[]): Range[] {
	const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
	const merged: Range[] = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
		else merged.push([...range]);
	}
	return merged;
}

/** A file's diff as git writes it, with one hunk for each range. */
function fileText(file: DiffFile, ranges: Range[]): string {
	const out = [...file.header];
	const at = sides(file);
	for (const [start, end] of ranges) {
		const slice = file.lines.slice(start, end + 1);
		const oldBefore = at.old.slice(0, start).filter((n) => n >= 0).length;
		const newBefore = at.new.slice(0, start).filter((n) => n >= 0).length;
		const oldCount = slice.filter((l) => l.kind !== "+").length;
		const newCount = slice.filter((l) => l.kind !== "-").length;
		const side = (before: number, count: number) => `${count === 0 ? before : before + 1}${count === 1 ? "" : `,${count}`}`;
		out.push(`@@ -${side(oldBefore, oldCount)} +${side(newBefore, newCount)} @@`);
		for (const line of slice) {
			out.push(line.kind + line.text);
			if (line.noNewline) out.push("\\ No newline at end of file");
		}
	}
	return out.join("\n");
}

/**
 * The diff Claude receives, with git's summary first: each change in a note with its whole section (CMP-10), or,
 * with `context`, with that many lines around each change. Files that aren't notes always get three lines.
 */
export function diffText(changes: ModelChanges, context?: number): string {
	const files = changes.files.map((file) => {
		const ranges = context === undefined && isNote(file.newPath ?? file.oldPath) ? sectionRanges(file) : contextRanges(file, context ?? 3);
		return fileText(file, ranges);
	});
	return [changes.stat, ...files].filter((part) => part !== "").join("\n\n") + "\n";
}

/** Marks a diff that was cut at the limit (CMP-11). */
export const DIFF_CUT = "\n\n[Diff cut short. Read the changed files in the model directory.]\n";
/** Says the diff shows three lines around each change because the whole sections were too long (CMP-11). */
export const DIFF_SHORT_CONTEXT = "[The changes with their whole sections were too long, so each change is shown with three lines around it.]\n\n";

/**
 * The diff as the prompt holds it (CMP-11): with whole sections when that fits in `limit` characters, else with
 * three lines around each change, cut at `limit` if it is still too long.
 */
export function limitedDiff(changes: ModelChanges, limit: number): string {
	const sections = diffText(changes);
	if (sections.length <= limit) return sections;
	const short = DIFF_SHORT_CONTEXT + diffText(changes, 3);
	if (short.length <= limit) return short;
	return short.slice(0, limit) + DIFF_CUT;
}
