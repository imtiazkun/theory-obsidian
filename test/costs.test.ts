import { describe, expect, it } from "vitest";
import {
	BUILT_IN_PRICES,
	NOT_REPORTED,
	addCosts,
	addUsage,
	claudeUsageParts,
	costOf,
	costParts,
	costText,
	formatDollars,
	historyCostTitle,
	modelKey,
	parsePrice,
	priceOf,
	readUsage,
	reportCostPieces,
	reportCosts,
	savedModelPrices,
} from "../src/costs";
import { fromSharedReport, toSharedReport } from "../src/shared-report";
import type { CompileReport } from "../src/compile";

const OPUS = { input: 1_000_000, output: 100_000, cacheWrites: 200_000, cacheReads: 2_000_000, model: "claude-opus-5-5" };

describe("tokens in four parts (REP-56)", () => {
	it("reads input, output, cache writes and cache reads from Claude Code's usage", () => {
		expect(claudeUsageParts({ input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 30, cache_read_input_tokens: 400 })).toEqual({
			input: 10,
			output: 2,
			cacheWrites: 30,
			cacheReads: 400,
		});
		expect(claudeUsageParts({ input_tokens: 10 })).toEqual({ input: 10, output: 0, cacheWrites: 0, cacheReads: 0 });
		expect(claudeUsageParts({})).toBeUndefined();
		expect(claudeUsageParts(undefined)).toBeUndefined();
	});

	it("adds each run's parts to the ones before, part by part, keeping the model that ran", () => {
		const first = addUsage(undefined, { input: 1, output: 2, cacheWrites: 3, cacheReads: 4 }, "claude-sonnet-5-5");
		expect(addUsage(first, { input: 10, output: 20, cacheWrites: 30, cacheReads: 40 })).toEqual({
			input: 11,
			output: 22,
			cacheWrites: 33,
			cacheReads: 44,
			model: "claude-sonnet-5-5",
		});
	});

	it("reads saved parts without breaking on what a teammate's file or an older version holds", () => {
		expect(readUsage(OPUS)).toEqual(OPUS);
		expect(readUsage({ input: -3, output: "x", cacheReads: 5 })).toEqual({ input: 0, output: 0, cacheWrites: 0, cacheReads: 5 });
		expect(readUsage(1234)).toBeUndefined();
		expect(readUsage(null)).toBeUndefined();
		expect(readUsage(["input"])).toBeUndefined();
		expect(readUsage({ model: "claude-opus-5-5" })).toBeUndefined();
	});
});

describe("prices (REP-57, CFG-48)", () => {
	it("knows the Claude models, with every part priced per million tokens", () => {
		const opus = priceOf("claude-opus-5-5");
		expect(opus).toEqual({ model: "claude-opus-5-5", input: 4, output: 20, cacheWrites: 5, cacheReads: 0.2 });
		for (const price of BUILT_IN_PRICES) {
			expect(price.model).toMatch(/^claude-/);
			// Cache writes are the 5-minute cache, at 1.25 times input.
			expect(price.cacheWrites).toBeCloseTo(price.input * 1.25);
			expect(price.cacheReads).toBeLessThan(price.input);
			expect(price.output).toBeGreaterThan(price.input);
		}
	});

	it("matches a model however Claude Code or a cloud names it", () => {
		expect(modelKey("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
		expect(modelKey("us.anthropic.claude-opus-4-7-v1:0")).toBe("claude-opus-4-7");
		expect(modelKey("claude-opus-4-6@20260101")).toBe("claude-opus-4-6");
		expect(modelKey("Claude-Sonnet-4-6[1m]")).toBe("claude-sonnet-4-6");
		expect(priceOf("claude-haiku-4-5-20251001")?.input).toBe(1);
		// A shorter name is a different model: claude-opus-5 is not claude-opus-5-5.
		expect(priceOf("claude-opus-5")?.input).toBe(5);
	});

	it("uses a price from the settings instead of the built-in one, and has none for a model on neither list", () => {
		const settings = [{ model: "claude-opus-5-5", input: 1, output: 2, cacheWrites: 3, cacheReads: 4 }];
		expect(priceOf("claude-opus-5-5-20260601", settings)).toEqual(settings[0]);
		expect(priceOf("gemini-pro", settings)).toBeUndefined();
		expect(priceOf("gemini-pro", [{ model: "gemini-pro", input: 1, output: 1, cacheWrites: 0, cacheReads: 0 }])?.input).toBe(1);
		expect(priceOf(undefined)).toBeUndefined();
	});

	it("starts the settings' list empty, and reads it without breaking on rows it can't use", () => {
		expect(savedModelPrices(undefined)).toEqual([]);
		expect(savedModelPrices("x")).toEqual([]);
		expect(
			savedModelPrices([{ model: " my-model ", input: 2, output: "x", cacheWrites: -1, cacheReads: 0.5 }, { model: "" }, null, { input: 3 }]),
		).toEqual([{ model: "my-model", input: 2, output: 0, cacheWrites: 0, cacheReads: 0.5 }]);
	});

	it("takes a typed price only when it is a number of dollars", () => {
		expect(parsePrice("4")).toBe(4);
		expect(parsePrice(" $0.25 ")).toBe(0.25);
		expect(parsePrice(".5")).toBe(0.5);
		expect(parsePrice("")).toBeNull();
		expect(parsePrice("-1")).toBeNull();
		expect(parsePrice("1e3")).toBeNull();
		expect(parsePrice("four")).toBeNull();
	});
});

describe("estimated costs (REP-57)", () => {
	it("prices each part at the price of the model that ran", () => {
		const cost = costOf(OPUS);
		expect(cost.kind).toBe("reported");
		if (cost.kind !== "reported") return;
		// $4 input, $20 output, $5 cache writes and $0.20 cache reads per million tokens.
		expect(cost.dollars).toEqual({ input: 4, output: 2, cacheWrites: 1, cacheReads: 0.4 });
		expect(costText(cost)).toBe("$7.40");
		expect(costParts(cost)).toEqual([
			"Model: claude-opus-5-5",
			"Input: 1,000,000 tokens ($4.00)",
			"Output: 100,000 tokens ($2.00)",
			"Cache writes: 200,000 tokens ($1.00)",
			"Cache reads: 2,000,000 tokens ($0.40)",
		]);
	});

	it("applies a price changed in the settings to old reports too", () => {
		const settings = [{ model: "claude-opus-5-5", input: 8, output: 40, cacheWrites: 10, cacheReads: 0.4 }];
		expect(costText(costOf(OPUS, settings))).toBe("$14.80");
	});

	it("says Price unknown for a model on neither list, and still shows the parts", () => {
		const cost = costOf({ ...OPUS, model: "some-other-model" });
		expect(costText(cost)).toBe("Price unknown");
		expect(costParts(cost)).toContain("Input: 1,000,000 tokens");
		expect(costText(costOf({ input: 5, output: 5, cacheWrites: 0, cacheReads: 0 }))).toBe("Price unknown");
	});

	it("says Not reported when the agent reported no tokens, like an ACP agent (AGT-20)", () => {
		expect(costOf(undefined)).toEqual(NOT_REPORTED);
		expect(costText(NOT_REPORTED)).toBe("Not reported");
		expect(costParts(NOT_REPORTED)).toEqual(["The agent reported no tokens."]);
	});

	it("shows an older report's single token count, with no price, without breaking", () => {
		const cost = costOf(12345);
		expect(costText(cost)).toBe("12,345 tokens");
		expect(costParts(cost)[0]).toMatch(/^12,345 tokens in all\./);
		expect(addCosts(cost, costOf(OPUS))).toEqual({ kind: "old", tokens: 12345 + 3_300_000 });
	});

	it("never shows a cost under a cent as free", () => {
		expect(formatDollars(0)).toBe("$0.00");
		expect(formatDollars(0.004)).toBe("<$0.01");
		expect(formatDollars(0.005)).toBe("$0.01");
		expect(formatDollars(12.345)).toBe("$12.35");
	});
});

describe("a report's costs: the compile, the build and the total (REP-56, REP-57)", () => {
	const SONNET = { input: 100_000, output: 10_000, cacheWrites: 0, cacheReads: 1_000_000, model: "claude-sonnet-5-5" };

	it("keeps the build's cost apart from the compile's, and adds them up", () => {
		const costs = reportCosts({
			tokens: OPUS,
			build: { startedAt: "2026-11-28T10:00:00.000Z", tokens: SONNET },
			builds: [{ startedAt: "2026-11-28T10:00:00Z", tokens: SONNET }],
		});
		expect(costText(costs.compile)).toBe("$7.40");
		// $0.20 input, $0.10 output and $0.10 cache reads: the latest build is in `builds` already, so it counts once.
		expect(costText(costs.build!)).toBe("$0.40");
		expect(costText(costs.total)).toBe("$7.80");
		expect(reportCostPieces(costs).map((p) => `${p.label} ${p.text}`)).toEqual(["Compile $7.40", "Build $0.40", "Total $7.80"]);
		expect(reportCostPieces(costs)[1].title).toBe(
			[
				"Build: $0.40",
				"Model: claude-sonnet-5-5",
				"Input: 100,000 tokens ($0.20)",
				"Output: 10,000 tokens ($0.10)",
				"Cache writes: 0 tokens ($0.00)",
				"Cache reads: 1,000,000 tokens ($0.10)",
			].join("\n"),
		);
	});

	it("counts every build of the compile, each at its own model's price, and a build still running", () => {
		const costs = reportCosts({
			tokens: OPUS,
			build: { startedAt: "2026-11-28T12:00:00.000Z", tokens: SONNET },
			builds: [{ startedAt: "2026-11-28T10:00:00Z", tokens: OPUS }],
		});
		expect(costText(costs.build!)).toBe("$7.80");
		expect(costs.build).toMatchObject({ models: ["claude-opus-5-5", "claude-sonnet-5-5"] });
		expect(costText(costs.total)).toBe("$15.20");
	});

	it("shows only the compile's cost before anything was built", () => {
		const costs = reportCosts({ tokens: OPUS });
		expect(costs.build).toBeNull();
		expect(reportCostPieces(costs).map((p) => p.label)).toEqual(["Compile"]);
	});

	it("makes the total Price unknown when one part has no price, and leaves out runs that reported nothing", () => {
		const unknown = reportCosts({ tokens: OPUS, builds: [{ startedAt: "2026-11-28T10:00:00Z", tokens: { ...SONNET, model: "other" } }] });
		expect(costText(unknown.total)).toBe("Price unknown");
		const acpCompile = reportCosts({ builds: [{ startedAt: "2026-11-28T10:00:00Z", tokens: SONNET }] });
		expect(costText(acpCompile.compile)).toBe("Not reported");
		expect(costText(acpCompile.total)).toBe("$0.40");
		const nothing = reportCosts({ builds: [{ startedAt: "x" }] });
		expect(costText(nothing.build!)).toBe("Not reported");
		expect(costText(nothing.total)).toBe("Not reported");
	});

	it("shows compile history's total, and the compile and build apart with their parts on hover (UI-16)", () => {
		const costs = reportCosts({ tokens: OPUS, builds: [{ startedAt: "2026-11-28T10:00:00Z", tokens: SONNET }] });
		const title = historyCostTitle(costs);
		expect(title.split("\n\n").map((section) => section.split("\n")[0])).toEqual(["Compile: $7.40", "Build: $0.40"]);
		expect(title).toContain("Cache reads: 2,000,000 tokens ($0.40)");
		expect(title).toContain("Cache reads: 1,000,000 tokens ($0.10)");
		expect(historyCostTitle(reportCosts({ tokens: OPUS }))).not.toContain("Build");
	});
});

describe("tokens in shared reports (REP-56, UI-16)", () => {
	const report = (extra: Partial<CompileReport> = {}): CompileReport => ({
		id: "1",
		status: "succeeded",
		startedAt: "2026-11-28T09:00:00.000Z",
		fromCommit: null,
		toCommit: "a".repeat(40),
		revisions: [],
		summary: "Planned.",
		changes: [],
		questions: [],
		problems: [],
		log: [],
		shared: { file: ".compiles/2026-11-28T09-00-00Z-abc123.json", shortId: "abc123" },
		...extra,
	});

	it("shares the compile's parts, so a teammate's report shows the same cost", () => {
		const shared = toSharedReport(report({ tokens: OPUS }), []);
		expect(shared.tokens).toEqual(OPUS);
		const read = fromSharedReport(JSON.parse(JSON.stringify(shared)), ".compiles/x.json", "/project");
		expect(costText(reportCosts(read).compile)).toBe("$7.40");
	});

	it("reads a file written before tokens were shared, and never shares an older single count", () => {
		const shared = toSharedReport(report({ tokens: 999 }), []);
		expect(shared).not.toHaveProperty("tokens");
		const read = fromSharedReport({ ...shared, tokens: "junk" as never }, ".compiles/x.json", "/project");
		expect(read.tokens).toBeUndefined();
		expect(costText(reportCosts(read).compile)).toBe("Not reported");
	});
});
