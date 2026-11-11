import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findRules } from "./rule-count";
import { git } from "./vault";

/** Who last changed one line of a note, as `git blame` sees it. `hash` is null for an uncommitted line. */
export interface LineAuthor {
	hash: string | null;
	author: string;
	/** Author date, in milliseconds. */
	authorTime: number;
	/** Commit date, in milliseconds, used to find the newest commit. */
	commitTime: number;
	subject: string;
}

/** The grey text after one rule's first line (HDR-14). */
export interface RuleAuthor {
	/** The rule's first line, counted from 0. */
	line: number;
	/** "Imtiaz · 2026-11-03 17:20", or "Not committed yet". */
	label: string;
	/** The commit's subject and short hash (HDR-18), or "" for an uncommitted rule. */
	tooltip: string;
}

export const NOT_COMMITTED = "Not committed yet";

/** `YYYY-MM-DD HH:mm` in local time (HDR-16). */
export function formatAuthorDate(ms: number): string {
	const d = new Date(ms);
	const two = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * Who last changed each rule: the author of the newest commit that changed any of its lines (HDR-15).
 * A rule with an uncommitted line, or a line git doesn't know, shows "Not committed yet" (HDR-17).
 */
export function ruleAuthors(text: string, lines: LineAuthor[]): RuleAuthor[] {
	return findRules(text).map((rule) => {
		let newest: LineAuthor | null = null;
		for (let i = rule.line; i <= rule.endLine; i++) {
			const line = lines[i];
			if (!line?.hash) return { line: rule.line, label: NOT_COMMITTED, tooltip: "" };
			if (!newest || line.commitTime > newest.commitTime) newest = line;
		}
		if (!newest?.hash) return { line: rule.line, label: NOT_COMMITTED, tooltip: "" };
		return {
			line: rule.line,
			label: `${newest.author} · ${formatAuthorDate(newest.authorTime)}`,
			tooltip: `${newest.subject} (${newest.hash.slice(0, 7)})`,
		};
	});
}

/** Reads `git blame --line-porcelain`: one entry per line of the blamed text. */
export function parseBlame(porcelain: string): LineAuthor[] {
	const result: LineAuthor[] = [];
	let current: Partial<LineAuthor> & { hash?: string | null } = {};
	for (const line of porcelain.split("\n")) {
		if (line.startsWith("\t")) {
			result.push({
				hash: current.hash ?? null,
				author: current.author ?? "",
				authorTime: current.authorTime ?? 0,
				commitTime: current.commitTime ?? 0,
				subject: current.subject ?? "",
			});
			current = {};
			continue;
		}
		const header = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
		if (header) {
			// Git marks lines that aren't committed with a hash of zeros.
			current.hash = /^0+$/.test(header[1]) ? null : header[1];
			continue;
		}
		const space = line.indexOf(" ");
		const key = space < 0 ? line : line.slice(0, space);
		const value = space < 0 ? "" : line.slice(space + 1);
		if (key === "author") current.author = value;
		else if (key === "author-time") current.authorTime = Number(value) * 1000;
		else if (key === "committer-time") current.commitTime = Number(value) * 1000;
		else if (key === "summary") current.subject = value;
	}
	return result;
}

/**
 * Blames `text`, the note at `path` in the vault as it is now, unsaved edits included. Every line is
 * uncommitted when git doesn't track the note yet. Worked out each time, never stored (HDR-19).
 */
export async function blameNote(vaultPath: string, path: string, text: string): Promise<LineAuthor[]> {
	const dir = mkdtempSync(join(tmpdir(), "theory-blame-"));
	try {
		const contents = join(dir, "note.md");
		writeFileSync(contents, text);
		const { stdout } = await git(vaultPath, ["blame", "--line-porcelain", "--contents", contents, "--", path]);
		return parseBlame(stdout);
	} catch {
		return [];
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** The rule authors of the note at `path`, with `text` as it is now in the editor. */
export async function noteRuleAuthors(vaultPath: string, path: string, text: string): Promise<RuleAuthor[]> {
	return ruleAuthors(text, await blameNote(vaultPath, path, text));
}
