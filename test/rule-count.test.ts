import { describe, expect, it } from "vitest";
import { countRules, ruleCountLabel, ruleCountTooltip } from "../src/rule-count";

describe("the rule count (HDR-9 to HDR-13)", () => {
	it("counts paragraphs and list items that start with a bold ID, with or without a period", () => {
		const count = countRules(
			[
				"Intro text with **PULL-9.** in the middle doesn't count.",
				"",
				"**PULL-6.** A vault without an origin never pulls.",
				"",
				"**CMT-8** When other files also changed.",
				"",
				"- **PULL-7.** A list item.",
				"1. **PULL-8** A numbered item.",
				"",
				"A paragraph",
				"**PULL-10.** on its second line isn't a rule.",
				"",
				"**pull-11.** Lower case isn't an ID.",
				"",
				"**PULL-12** **bold** later.",
				"",
				"## Heading",
				"**PULL-13.** Right under a heading.",
			].join("\n"),
		);
		expect(count.total).toBe(6);
		expect(count.prefixes).toEqual([
			{ prefix: "PULL", count: 5, lowest: 6, highest: 13 },
			{ prefix: "CMT", count: 1, lowest: 8, highest: 8 },
		]);
		expect(count.duplicates).toEqual([]);
	});

	it("leaves out code blocks and front matter", () => {
		const count = countRules(
			[
				"---",
				"realized: false",
				"note: **FM-1.** in front matter",
				"---",
				"**HDR-1.** Counted.",
				"",
				"```",
				"**CODE-1.** In a fence.",
				"",
				"**CODE-2.** Still in it.",
				"```",
				"",
				"~~~md",
				"**CODE-3.** Tilde fence.",
				"~~~",
				"",
				"    **CODE-4.** Indented code.",
				"",
				"**HDR-2.** Counted.",
			].join("\n"),
		);
		expect(count.total).toBe(2);
		expect(count.prefixes).toEqual([{ prefix: "HDR", count: 2, lowest: 1, highest: 2 }]);
	});

	it("says a note with one rule has 1 rule, and shows nothing without rules", () => {
		expect(ruleCountLabel(countRules("**CMT-8** Only one."))).toBe("1 rule");
		expect(ruleCountLabel(countRules("No rules here.\n"))).toBe("");
		expect(ruleCountLabel(countRules("**A-1.** a\n\n**A-2.** b\n"))).toBe("2 rules");
	});

	it("lists each prefix in the tooltip with its count and range", () => {
		const text = Array.from({ length: 22 }, (_, i) => `**PULL-${i + 1}.** Rule.`).join("\n\n");
		expect(ruleCountTooltip(countRules(text))).toBe("PULL: 22 rules, PULL-1 to PULL-22");
	});

	it("finds an ID declared more than once", () => {
		const count = countRules("**PULL-6.** One.\n\n**PULL-6.** Two.\n\n**PULL-7.** Three.\n\n- **PULL-7.** a\n- **PULL-7.** b\n");
		expect(count.duplicates).toEqual([
			{ id: "PULL-6", times: 2 },
			{ id: "PULL-7", times: 3 },
		]);
		expect(ruleCountTooltip(count)).toBe("PULL: 5 rules, PULL-6 to PULL-7\nPULL-6 is declared twice.\nPULL-7 is declared 3 times.");
	});
});
