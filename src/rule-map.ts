import { lstat, readFile } from "fs/promises";
import { join } from "path";
import { DiffFile, fileSides, isNote, sides } from "./model-diff";
import { findRules } from "./rule-count";

/** A rule the pending revisions change (CMP-92), and the note it is defined in on the side that changed. */
export interface ChangedRule {
	id: string;
	path: string;
}

/**
 * The changed rules (CMP-92): every rule whose paragraph or list item holds a line the diff removes (in the note
 * before) or adds (in the note after), its defining line included. IDs only mentioned in passing never count, since
 * `findRules` finds only bold IDs that start a paragraph or list item. In the order the diff shows them; a rule that
 * moved between notes is listed once for each note.
 */
export function changedRules(files: DiffFile[]): ChangedRule[] {
	const found: ChangedRule[] = [];
	const seen = new Set<string>();
	for (const file of files) {
		if (!isNote(file.oldPath) && !isNote(file.newPath)) continue;
		const text = fileSides(file);
		const oldRules = findRules(text.old.join("\n"));
		const newRules = findRules(text.new.join("\n"));
		const at = sides(file);
		file.lines.forEach((line, i) => {
			if (line.kind === " ") return;
			const [rules, index, path] = line.kind === "-" ? [oldRules, at.old[i], file.oldPath] : [newRules, at.new[i], file.newPath];
			if (path === null) return;
			for (const rule of rules) {
				if (index < rule.line || index > rule.endLine) continue;
				const id = `${rule.prefix}-${rule.number}`;
				const key = `${id}\0${path}`;
				if (seen.has(key)) continue;
				seen.add(key);
				found.push({ id, path });
			}
		});
	}
	return found;
}

/** A repository in the code snapshot, with the files git tracks in it (CMP-93). */
export interface SnapshotRepo {
	name: string;
	files: string[];
}

/** Files larger than this are never searched: they are generated or data, not code a rule would cite. */
const MAX_SEARCHED_BYTES = 1024 * 1024;

/**
 * Searches the code snapshot for each rule ID as a whole word, in the files git tracks (CMP-93). Each hit is
 * `{repo}/{path}:{line}`, in the order they appear in the code: by repository, then git's order of paths, then line.
 * Binary files, symbolic links and files over 1 MB are skipped. Only reads, so no repository changes (CMP-85).
 */
export async function searchRules(ids: string[], codeDir: string, repos: SnapshotRepo[]): Promise<Map<string, string[]>> {
	const hits = new Map<string, string[]>(ids.map((id) => [id, []]));
	if (ids.length === 0) return hits;
	// Longest first, so CMP-10 is tried before CMP-1; the boundaries keep CMP-1 from matching inside CMP-10.
	const pattern = new RegExp(`\\b(${[...ids].sort((a, b) => b.length - a.length).join("|")})\\b`, "g");
	for (const repo of repos) {
		for (const path of repo.files) {
			const full = join(codeDir, repo.name, path);
			const info = await lstat(full).catch(() => null);
			if (!info?.isFile() || info.size > MAX_SEARCHED_BYTES) continue;
			const bytes = await readFile(full).catch(() => null);
			if (!bytes || bytes.subarray(0, 8000).includes(0)) continue;
			const lines = bytes.toString("utf8").split("\n");
			lines.forEach((line, i) => {
				const onLine = new Set<string>();
				for (const match of line.matchAll(pattern)) onLine.add(match[1]);
				for (const id of onLine) hits.get(id)?.push(`${repo.name}/${path}:${i + 1}`);
			});
		}
	}
	return hits;
}

/** At most this many hits per rule in the map (CMP-94). */
export const HITS_PER_RULE = 20;
/** At most this many hits in the whole map (CMP-94). */
export const HITS_IN_ALL = 500;

/** One rule in the map: where it's defined, the hits kept and how many there were in all. */
export interface RuleMapEntry {
	id: string;
	notes: string[];
	hits: string[];
	found: number;
}

/** The rule map Claude receives (CMP-94). `omitted` counts the hits the 500 limit left out. */
export interface RuleMap {
	rules: RuleMapEntry[];
	omitted: number;
}

/**
 * The rule map (CMP-94): each changed rule with its first hits, at most 20 per rule and 500 in all. When the map
 * would hold more than 500, each rule keeps its first hits, shared out one at a time so every rule keeps some.
 */
export function ruleMap(changed: ChangedRule[], hits: Map<string, string[]>, perRule = HITS_PER_RULE, inAll = HITS_IN_ALL): RuleMap {
	const ids: string[] = [];
	const notes = new Map<string, string[]>();
	for (const rule of changed) {
		if (!notes.has(rule.id)) {
			ids.push(rule.id);
			notes.set(rule.id, []);
		}
		notes.get(rule.id)!.push(rule.path);
	}
	const wanted = ids.map((id) => Math.min(hits.get(id)?.length ?? 0, perRule));
	const kept = ids.map(() => 0);
	let left = inAll;
	for (let round = 0; round < perRule && left > 0; round++) {
		for (let i = 0; i < ids.length && left > 0; i++) {
			if (kept[i] < wanted[i]) {
				kept[i]++;
				left--;
			}
		}
	}
	const omitted = wanted.reduce((sum, n, i) => sum + n - kept[i], 0);
	return {
		rules: ids.map((id, i) => ({ id, notes: notes.get(id)!, hits: (hits.get(id) ?? []).slice(0, kept[i]), found: hits.get(id)?.length ?? 0 })),
		omitted,
	};
}

export const NOT_FOUND = "Not found in the code";

/** The rule map as the prompt holds it (CMP-94), with what Claude is told about it (CMP-95). */
export function ruleMapText(map: RuleMap): string {
	if (map.rules.length === 0) return "No rule is added, removed or changed in these revisions, so the rule map is empty.";
	const lines = map.rules.map((rule) => {
		const left = rule.found - rule.hits.length;
		const where =
			rule.found === 0
				? NOT_FOUND
				: rule.hits.length === 0
					? `${rule.found} ${rule.found === 1 ? "hit" : "hits"}, left out of the map`
					: `${rule.hits.join(", ")}${left > 0 ? ` (and ${left} more)` : ""}`;
		return `- ${rule.id} (${rule.notes.join(", ")}): ${where}`;
	});
	if (map.omitted > 0) lines.push(`The map holds at most ${HITS_IN_ALL} hits, so ${map.omitted} ${map.omitted === 1 ? "hit was" : "hits were"} left out.`);
	return `Each rule these revisions add, remove or change, with the note it is in and every place in the code snapshot that names its ID (paths relative to the code snapshot, with the line). The map is a starting point, not the whole truth: a hit may be an unrelated mention, and code may follow a rule without citing its ID. Open the files in the map before you search on your own.

${lines.join("\n")}`;
}

/** The first folder of a vault path, or null for a note at the root. */
function topFolder(path: string): string | null {
	const slash = path.indexOf("/");
	return slash === -1 ? null : path.slice(0, slash);
}

/**
 * A compile's scope (CMP-96): each repository whose model folder holds a changed note; every repository when a
 * changed rule sits in a note outside every model folder; in a recompile, also each repository of an earlier issue
 * that is still open. Hidden notes and the root Instructions never count, as the diff never holds them. In the order
 * of `repos`.
 */
export function compileScope(repos: string[], files: DiffFile[], rules: ChangedRule[], earlier: { repo: string }[] = []): string[] {
	if (rules.some((rule) => !repos.includes(topFolder(rule.path) ?? ""))) return [...repos];
	const inScope = new Set<string>(earlier.map((issue) => issue.repo));
	for (const file of files) {
		for (const path of [file.oldPath, file.newPath]) {
			const folder = path !== null && isNote(path) ? topFolder(path) : null;
			if (folder !== null && repos.includes(folder)) inScope.add(folder);
		}
	}
	return repos.filter((repo) => inScope.has(repo));
}

/** The scope as the prompt holds it (CMP-97). */
export function scopeText(scope: string[]): string {
	const outside =
		"You may read code outside the scope to understand how the repositories connect, but plan issues only inside it. When you find work needed outside the scope, don't plan it: ask a question naming the notes that should say so, since a model folder describes its repository only.";
	if (scope.length === 0) {
		return `No repository is in this compile's scope: no note in a model folder changed, and no rule changed in a note outside every model folder. Plan no issues. ${outside}`;
	}
	return `This compile may plan issues only in these repositories: ${scope.join(", ")}. ${outside}`;
}
