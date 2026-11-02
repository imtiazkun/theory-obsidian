import { readFile, realpath, stat } from "fs/promises";
import { join, posix, sep } from "path";

/** Where in the model a problem comes from. Claude names it; the plugin checks it before showing it. */
export interface Anchor {
	/** Model file, relative to the vault root. */
	path: string;
	/** Heading the problem sits under, as written in the note. */
	heading?: string;
	/** Short text copied from the note. Found by search, so it survives edits elsewhere in the note. */
	quote?: string;
}

export interface Problem {
	text: string;
	/** Empty when the problem isn't about the model, e.g. a failed build. */
	anchors: Anchor[];
}

const MAX_PROBLEM_CHARS = 2000;
const MAX_ANCHOR_CHARS = 300;
const MAX_ANCHORS = 5;

export function plainProblem(text: string): Problem {
	return { text, anchors: [] };
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeHeading(heading: string): string {
	return heading.replace(/^#+/, "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Finds an anchor in a note's text: its quote, else its heading line. Whitespace in the quote may differ. */
export function findAnchor(text: string, anchor: Anchor): { from: number; to: number } | null {
	if (anchor.quote) {
		const words = anchor.quote.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
		const match = words.length > 0 ? new RegExp(words.join("\\s+")).exec(text) : null;
		if (match) return { from: match.index, to: match.index + match[0].length };
	}
	if (anchor.heading) {
		const wanted = normalizeHeading(anchor.heading);
		for (const match of text.matchAll(/^#{1,6}[ \t]+(.*)$/gm)) {
			if (normalizeHeading(match[1]) === wanted) return { from: match.index, to: match.index + match[0].length };
		}
	}
	return null;
}

/** Keeps an anchor only when its file is in the snapshot, and its heading and quote only when they're in that file. */
async function checkAnchor(snapshot: string, claimed: unknown): Promise<Anchor | null> {
	const { path, heading, quote } = (claimed ?? {}) as Record<string, unknown>;
	if (typeof path !== "string") return null;
	const relative = posix.normalize(path.trim().replace(/^\.?\//, ""));
	if (relative === "." || relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative)) return null;
	// realpath follows symlinks, so a link can't point outside the snapshot either.
	const full = await realpath(join(snapshot, relative)).catch(() => null);
	if (!full || !full.startsWith(snapshot + sep) || !(await stat(full)).isFile()) return null;

	const text = await readFile(full, "utf8");
	const anchor: Anchor = { path: relative };
	if (typeof heading === "string" && heading.trim()) {
		const candidate = heading.trim().slice(0, MAX_ANCHOR_CHARS);
		if (findAnchor(text, { path: relative, heading: candidate })) anchor.heading = candidate;
	}
	if (typeof quote === "string" && quote.trim()) {
		const candidate = quote.trim().slice(0, MAX_ANCHOR_CHARS);
		if (findAnchor(text, { path: relative, quote: candidate })) anchor.quote = candidate;
	}
	return anchor;
}

/**
 * Turns the problems Claude reported into plain text plus checked anchors. With no snapshot to
 * check against, every anchor is dropped.
 */
export async function checkProblems(snapshot: string | null, claimed: unknown): Promise<Problem[]> {
	if (!Array.isArray(claimed)) return [];
	const problems: Problem[] = [];
	for (const item of claimed) {
		const { problem, anchors } = (typeof item === "string" ? { problem: item } : (item ?? {})) as Record<string, unknown>;
		if (typeof problem !== "string" || !problem.trim()) continue;
		const checked: Anchor[] = [];
		if (snapshot && Array.isArray(anchors)) {
			for (const claimedAnchor of anchors.slice(0, MAX_ANCHORS)) {
				const anchor = await checkAnchor(snapshot, claimedAnchor).catch(() => null);
				if (anchor) checked.push(anchor);
			}
		}
		problems.push({ text: problem.trim().slice(0, MAX_PROBLEM_CHARS), anchors: checked });
	}
	return problems;
}
