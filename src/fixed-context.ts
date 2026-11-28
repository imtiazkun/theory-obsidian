import { lstat, readFile, readdir, realpath } from "fs/promises";
import { isAbsolute, join, relative, sep } from "path";

/** Fixed context is cut at this many characters in all (CMP-106). */
export const FIXED_CONTEXT_CHARS = 60_000;
/** At most this many tracked paths per repository (CMP-106). */
export const PATHS_PER_REPO = 300;

/** One part of the fixed context: its heading, its text, and how it is named when it is cut. */
export interface FixedPart {
	title: string;
	text: string;
	/** Where Claude finds it when the part is cut, like "api/AGENTS.md in the code snapshot". */
	where: string;
}

/**
 * The file named `name` (ignoring case) directly in `dir`, as text, or null. A symbolic link counts only when it
 * stays inside `root`, so nothing outside the snapshot is ever read into the prompt.
 */
async function readNamed(dir: string, name: string, root: string): Promise<{ name: string; text: string } | null> {
	const entries = await readdir(dir).catch(() => [] as string[]);
	const found = entries.find((entry) => entry.toLowerCase() === name.toLowerCase());
	if (!found) return null;
	const path = join(dir, found);
	const info = await lstat(path).catch(() => null);
	if (!info) return null;
	if (info.isSymbolicLink()) {
		const target = await realpath(path).catch(() => null);
		const base = await realpath(root).catch(() => null);
		const rel = target !== null && base !== null ? relative(base, target) : "..";
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
	} else if (!info.isFile()) {
		return null;
	}
	const text = await readFile(path, "utf8").catch(() => null);
	return text === null ? null : { name: found, text };
}

/** A repository in the scope, with the files git tracks in it. */
export interface ScopeRepo {
	name: string;
	files: string[];
}

/**
 * The parts of the fixed context (CMP-106), in order: the root `Index.md` from the model snapshot, then for each
 * repository in the scope its `AGENTS.md` and `CLAUDE.md` from the code snapshot, when they exist, and the files git
 * tracks in it, at most 300. A `CLAUDE.md` with the same text as `AGENTS.md` is sent once.
 */
export async function fixedParts(modelSnapshot: string, codeDir: string, scope: ScopeRepo[]): Promise<FixedPart[]> {
	const parts: FixedPart[] = [];
	const index = await readNamed(modelSnapshot, "Index.md", modelSnapshot);
	if (index) parts.push({ title: `${index.name} (in the model directory)`, text: index.text, where: `${index.name} in the model directory` });
	for (const repo of scope) {
		const dir = join(codeDir, repo.name);
		const agents = await readNamed(dir, "AGENTS.md", dir);
		const claude = await readNamed(dir, "CLAUDE.md", dir);
		if (agents) parts.push({ title: `${repo.name}/${agents.name}`, text: agents.text, where: `${repo.name}/${agents.name} in the code snapshot` });
		if (claude) {
			const same = agents !== null && agents.text.trim() === claude.text.trim();
			parts.push({
				title: `${repo.name}/${claude.name}`,
				text: same ? `The same text as ${repo.name}/${agents.name}.` : claude.text,
				where: `${repo.name}/${claude.name} in the code snapshot`,
			});
		}
		const shown = repo.files.slice(0, PATHS_PER_REPO);
		const left = repo.files.length - shown.length;
		const list = shown.join("\n") + (left > 0 ? `\n[${left} more ${left === 1 ? "path was" : "paths were"} left out.]` : "");
		parts.push({
			title: `Files git tracks in ${repo.name}`,
			text: repo.files.length > 0 ? list : "None.",
			where: `the list of files in ${repo.name}/ in the code snapshot`,
		});
	}
	return parts;
}

/**
 * The fixed context as the prompt holds it (CMP-106), cut at `limit` characters in all. The part that doesn't fit is
 * cut where the limit falls, and it and every part after it are named, so Claude can still read them.
 */
export function fixedContextText(parts: FixedPart[], limit = FIXED_CONTEXT_CHARS): string {
	const blocks: string[] = [];
	const cut: string[] = [];
	let used = 0;
	for (const part of parts) {
		const block = `### ${part.title}\n\n${part.text.trim()}`;
		if (cut.length === 0 && used + block.length <= limit) {
			blocks.push(block);
			used += block.length;
			continue;
		}
		if (cut.length === 0 && limit - used > 0) blocks.push(`${block.slice(0, limit - used)}\n\n[Cut here. Read the rest in ${part.where}.]`);
		cut.push(part.where);
	}
	const intro = "These files are given here so you don't have to read them. Don't read them again.";
	const left = cut.length > 0 ? `\n\nThe fixed context is cut at ${limit.toLocaleString("en-US")} characters. Read these yourself if you need them: ${cut.join("; ")}.` : "";
	return `${intro}\n\n${blocks.join("\n\n")}${left}`;
}
