/** One rule prefix in a note, like PULL in PULL-1 to PULL-22. */
export interface RulePrefix {
	prefix: string;
	count: number;
	lowest: number;
	highest: number;
}

export interface RuleCount {
	/** Every rule declared, a duplicate ID counted each time. */
	total: number;
	/** In the order each prefix first appears. */
	prefixes: RulePrefix[];
	/** IDs declared more than once, with how many times, in the order they first appear. */
	duplicates: { id: string; times: number }[];
}

// A list marker, if any, then a bold ID: capital letters, a dash and a number, with or without a period (HDR-10).
const RULE = /^(?:[-*+][ \t]+|\d+[.)][ \t]+)?\*\*([A-Z]+)-(\d+)\.?\*\*/;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/** One rule a note declares: its ID and the lines it spans, counted from 0 over the whole text. */
export interface RuleSpan {
	prefix: string;
	number: number;
	/** The rule's first line. */
	line: number;
	/** The rule's last line: where its paragraph or list item ends (HDR-15). */
	endLine: number;
}

/**
 * Finds the rules a note declares: paragraphs and list items that start with a bold ID. Front matter,
 * fenced code and indented code never count (HDR-10).
 */
export function findRules(text: string): RuleSpan[] {
	const lines = text.split(/\r?\n/);
	let start = 0;
	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex((line, i) => i > 0 && (line.trim() === "---" || line.trim() === "..."));
		if (end > 0) start = end + 1;
	}

	const rules: RuleSpan[] = [];
	// The rule whose paragraph or list item is still going on.
	let open: RuleSpan | null = null;
	let fence: string | null = null;
	// True at the first line of a paragraph: after a blank line, a heading, a fence or the start.
	let paragraphStart = true;
	let inList = false;
	for (let i = start; i < lines.length; i++) {
		const line = lines[i];
		const opened = FENCE.exec(line);
		if (fence !== null) {
			if (opened && opened[1][0] === fence[0] && opened[1].length >= fence.length && line.trim() === opened[1]) fence = null;
			paragraphStart = fence === null;
			continue;
		}
		if (opened) {
			fence = opened[1];
			open = null;
			continue;
		}
		if (line.trim() === "") {
			paragraphStart = true;
			open = null;
			continue;
		}
		const indented = /^(?: {4}|\t)/.test(line);
		// Indented text after a blank line, outside a list, is a code block.
		if (indented && paragraphStart && !inList) continue;
		const listItem = LIST_ITEM.test(line);
		if (listItem) inList = true;
		else if (!indented && paragraphStart) inList = false;

		if (/^#{1,6}([ \t]|$)/.test(line)) {
			paragraphStart = true;
			open = null;
			continue;
		}
		// A new list item ends the paragraph or list item before it.
		if (listItem) open = null;
		if (paragraphStart || listItem) {
			const match = RULE.exec(line.trimStart());
			if (match) {
				open = { prefix: match[1], number: Number(match[2]), line: i, endLine: i };
				rules.push(open);
			}
		} else if (open) {
			open.endLine = i;
		}
		paragraphStart = false;
	}
	return rules;
}

/** Counts the rules a note declares (HDR-9, HDR-10). */
export function countRules(text: string): RuleCount {
	const ids = findRules(text);
	const prefixes = new Map<string, RulePrefix>();
	const seen = new Map<string, number>();
	for (const { prefix, number } of ids) {
		const found = prefixes.get(prefix);
		if (found) {
			found.count++;
			found.lowest = Math.min(found.lowest, number);
			found.highest = Math.max(found.highest, number);
		} else {
			prefixes.set(prefix, { prefix, count: 1, lowest: number, highest: number });
		}
		const id = `${prefix}-${number}`;
		seen.set(id, (seen.get(id) ?? 0) + 1);
	}
	const duplicates = [...seen].filter(([, times]) => times > 1).map(([id, times]) => ({ id, times }));
	return { total: ids.length, prefixes: [...prefixes.values()], duplicates };
}

/** "12 rules", "1 rule", or "" for a note without rules (HDR-9). */
export function ruleCountLabel(count: RuleCount): string {
	if (count.total === 0) return "";
	return `${count.total} ${count.total === 1 ? "rule" : "rules"}`;
}

function times(n: number): string {
	return n === 2 ? "twice" : `${n} times`;
}

/** Each prefix with its count and range, then each ID declared more than once (HDR-12, HDR-13). */
export function ruleCountTooltip(count: RuleCount): string {
	const lines = count.prefixes.map(({ prefix, count: n, lowest, highest }) => {
		const range = lowest === highest ? `${prefix}-${lowest}` : `${prefix}-${lowest} to ${prefix}-${highest}`;
		return `${prefix}: ${n} ${n === 1 ? "rule" : "rules"}, ${range}`;
	});
	for (const { id, times: n } of count.duplicates) lines.push(`${id} is declared ${times(n)}.`);
	return lines.join("\n");
}
