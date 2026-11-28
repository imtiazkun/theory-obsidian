/**
 * Tokens in four parts, model prices and the estimated costs worked out from them (REP-56, REP-57, CFG-48, UI-16).
 * Plain functions with no Obsidian dependency, so they can be tested.
 */

/** A run's tokens in four parts (REP-56). */
export interface TokenParts {
	input: number;
	output: number;
	cacheWrites: number;
	cacheReads: number;
}

/** The tokens an agent reported, with the model that ran, as the agent named it. Unset model means it didn't say. */
export interface TokenUsage extends TokenParts {
	model?: string;
}

/** A model's price in US dollars per million tokens, for each part (CFG-48). */
export interface ModelPrice extends TokenParts {
	model: string;
}

export const PARTS: readonly (keyof TokenParts)[] = ["input", "output", "cacheWrites", "cacheReads"];

export const PART_NAMES: Record<keyof TokenParts, string> = {
	input: "Input",
	output: "Output",
	cacheWrites: "Cache writes",
	cacheReads: "Cache reads",
};

/**
 * The Claude models the plugin knows, per million tokens (REP-57). Cache writes are the 5-minute cache, which is what
 * Claude Code writes, at 1.25 times input. Anthropic's first-party API prices as of November 2026. Claude Haiku 5.5's
 * price is for prompts of up to 100K tokens. A model in the settings' Model prices list overrides its entry (CFG-48).
 */
export const BUILT_IN_PRICES: readonly ModelPrice[] = [
	{ model: "claude-fable-5-2", input: 8, output: 40, cacheWrites: 10, cacheReads: 0.2 },
	{ model: "claude-mythos-5-2", input: 8, output: 40, cacheWrites: 10, cacheReads: 0.2 },
	{ model: "claude-fable-5-1", input: 10, output: 50, cacheWrites: 12.5, cacheReads: 0.25 },
	{ model: "claude-mythos-5-1", input: 10, output: 50, cacheWrites: 12.5, cacheReads: 0.25 },
	{ model: "claude-fable-5", input: 10, output: 50, cacheWrites: 12.5, cacheReads: 1 },
	{ model: "claude-mythos-5", input: 10, output: 50, cacheWrites: 12.5, cacheReads: 1 },
	{ model: "claude-opus-5-5", input: 4, output: 20, cacheWrites: 5, cacheReads: 0.2 },
	{ model: "claude-opus-5", input: 5, output: 25, cacheWrites: 6.25, cacheReads: 0.5 },
	{ model: "claude-opus-4-8", input: 5, output: 25, cacheWrites: 6.25, cacheReads: 0.5 },
	{ model: "claude-opus-4-7", input: 5, output: 25, cacheWrites: 6.25, cacheReads: 0.5 },
	{ model: "claude-opus-4-6", input: 5, output: 25, cacheWrites: 6.25, cacheReads: 0.5 },
	{ model: "claude-sonnet-5-5", input: 2, output: 10, cacheWrites: 2.5, cacheReads: 0.1 },
	{ model: "claude-sonnet-5", input: 2, output: 10, cacheWrites: 2.5, cacheReads: 0.2 },
	{ model: "claude-sonnet-4-6", input: 3, output: 15, cacheWrites: 3.75, cacheReads: 0.3 },
	{ model: "claude-haiku-5-5", input: 0.1, output: 0.5, cacheWrites: 0.125, cacheReads: 0.01 },
	{ model: "claude-haiku-4-5", input: 1, output: 5, cacheWrites: 1.25, cacheReads: 0.1 },
];

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

/** The four parts of a Claude Code `usage` object, or undefined when it has no token count at all. */
export function claudeUsageParts(usage: unknown): TokenParts | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const u = usage as Record<string, unknown>;
	const keys = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
	if (!keys.some((key) => typeof u[key] === "number")) return undefined;
	return {
		input: count(u.input_tokens),
		output: count(u.output_tokens),
		cacheWrites: count(u.cache_creation_input_tokens),
		cacheReads: count(u.cache_read_input_tokens),
	};
}

/** `total` with `parts` added, part by part. The model is the one that ran last, when the agent named it. */
export function addUsage(total: TokenUsage | number | undefined, parts: TokenParts, model?: string): TokenUsage {
	const base = readUsage(total);
	const sum: TokenUsage = {
		input: (base?.input ?? 0) + parts.input,
		output: (base?.output ?? 0) + parts.output,
		cacheWrites: (base?.cacheWrites ?? 0) + parts.cacheWrites,
		cacheReads: (base?.cacheReads ?? 0) + parts.cacheReads,
	};
	const ran = model || base?.model;
	if (ran) sum.model = ran;
	return sum;
}

/**
 * Token parts as saved in plugin data or a shared report, or undefined when there are none. Never throws on a value
 * it doesn't know: a teammate's file or an older version's data may hold anything. A number is the single count
 * reports kept before REP-56, which has no parts: see `costOf`.
 */
export function readUsage(value: unknown): TokenUsage | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const v = value as Record<string, unknown>;
	if (!PARTS.some((part) => typeof v[part] === "number")) return undefined;
	const usage: TokenUsage = { input: count(v.input), output: count(v.output), cacheWrites: count(v.cacheWrites), cacheReads: count(v.cacheReads) };
	if (typeof v.model === "string" && v.model.trim()) usage.model = v.model.trim();
	return usage;
}

/**
 * A model name as prices are matched by: lower case, without a provider prefix (`us.anthropic.`), a date stamp
 * (`-20251001`, `@20251001`), a Bedrock version (`-v1:0`) or a context suffix (`[1m]`). So `claude-haiku-4-5-20251001`
 * gets the price of `claude-haiku-4-5`.
 */
export function modelKey(model: string): string {
	return model
		.trim()
		.toLowerCase()
		.replace(/\[[^\]]*\]$/, "")
		.replace(/^(?:[a-z]{2,4}\.)?anthropic\./, "")
		.replace(/-v\d+(?::\d+)?$/, "")
		.replace(/[-@]\d{8}$/, "");
}

/** The price of `model`: from the settings' list first, then the built-in one (CFG-48, REP-57). Undefined when neither has it. */
export function priceOf(model: string | undefined, prices: readonly ModelPrice[] = []): ModelPrice | undefined {
	if (!model) return undefined;
	const key = modelKey(model);
	if (!key) return undefined;
	return prices.find((p) => modelKey(p.model) === key) ?? BUILT_IN_PRICES.find((p) => modelKey(p.model) === key);
}

/** Each part's cost in US dollars at `price`. */
function partDollars(parts: TokenParts, price: TokenParts): TokenParts {
	return {
		input: (parts.input * price.input) / 1e6,
		output: (parts.output * price.output) / 1e6,
		cacheWrites: (parts.cacheWrites * price.cacheWrites) / 1e6,
		cacheReads: (parts.cacheReads * price.cacheReads) / 1e6,
	};
}

const sumParts = (a: TokenParts, b: TokenParts): TokenParts => ({
	input: a.input + b.input,
	output: a.output + b.output,
	cacheWrites: a.cacheWrites + b.cacheWrites,
	cacheReads: a.cacheReads + b.cacheReads,
});

const totalOf = (parts: TokenParts) => parts.input + parts.output + parts.cacheWrites + parts.cacheReads;

/**
 * An estimated cost (REP-57).
 * - `not-reported`: the agent reported no tokens, like an ACP agent (AGT-20).
 * - `old`: a report from before REP-56 kept one token count, with no parts, so it has no price.
 * - `reported`: the four parts, the models that ran, and each part's dollars, or null when a model has no price.
 */
export type Cost =
	| { kind: "not-reported" }
	| { kind: "old"; tokens: number }
	| { kind: "reported"; parts: TokenParts; models: string[]; dollars: TokenParts | null };

export const NOT_REPORTED: Cost = { kind: "not-reported" };

/** The cost of one run's saved tokens, at today's prices: a price changed in the settings applies to old reports too (CFG-48). */
export function costOf(tokens: unknown, prices: readonly ModelPrice[] = []): Cost {
	if (typeof tokens === "number" && Number.isFinite(tokens)) return { kind: "old", tokens };
	const usage = readUsage(tokens);
	if (!usage) return NOT_REPORTED;
	const parts: TokenParts = { input: usage.input, output: usage.output, cacheWrites: usage.cacheWrites, cacheReads: usage.cacheReads };
	const price = priceOf(usage.model, prices);
	return { kind: "reported", parts, models: usage.model ? [usage.model] : [], dollars: price ? partDollars(parts, price) : null };
}

/** Two costs together, as a build's runs or a compile and its build add up. A part with no price makes the sum unknown. */
export function addCosts(a: Cost, b: Cost): Cost {
	if (a.kind === "not-reported") return b;
	if (b.kind === "not-reported") return a;
	if (a.kind === "old" || b.kind === "old") {
		const tokens = (c: Cost) => (c.kind === "old" ? c.tokens : c.kind === "reported" ? totalOf(c.parts) : 0);
		return { kind: "old", tokens: tokens(a) + tokens(b) };
	}
	return {
		kind: "reported",
		parts: sumParts(a.parts, b.parts),
		models: [...new Set([...a.models, ...b.models])],
		dollars: a.dollars && b.dollars ? sumParts(a.dollars, b.dollars) : null,
	};
}

/** What a report's tokens are read from: the compile's, and each build's (REP-56). */
export interface CostedReport {
	tokens?: unknown;
	/** The latest build, which may still run or have been cut short, so it may not be in `builds` yet. */
	build?: { startedAt: string; tokens?: unknown };
	/** Every build that ended. */
	builds?: { startedAt: string; tokens?: unknown }[];
}

/** The compile's cost, the build's (null when nothing was built), and their total (REP-57). */
export interface ReportCosts {
	compile: Cost;
	build: Cost | null;
	total: Cost;
}

const sameTime = (a: string, b: string) => a === b || (Date.parse(a) === Date.parse(b) && !Number.isNaN(Date.parse(a)));

/** A report's costs. Every build of the compile counts towards the build's cost, each at its own model's price. */
export function reportCosts(report: CostedReport, prices: readonly ModelPrice[] = []): ReportCosts {
	const compile = costOf(report.tokens, prices);
	const builds = Array.isArray(report.builds) ? report.builds.filter((b) => b && typeof b === "object") : [];
	const runs = [...builds];
	// The latest build joins `builds` only once it ended; until then, or when Obsidian closed during it, it counts too.
	if (report.build && !builds.some((b) => typeof b.startedAt === "string" && sameTime(b.startedAt, report.build!.startedAt))) runs.push(report.build);
	const build = runs.length > 0 ? runs.map((b) => costOf(b.tokens, prices)).reduce(addCosts, NOT_REPORTED) : null;
	return { compile, build, total: addCosts(compile, build ?? NOT_REPORTED) };
}

const tokenCount = new Intl.NumberFormat("en-US");

/** US dollars, like "$1.24". A cost under a cent shows as "<$0.01", so it never reads as free. */
export function formatDollars(dollars: number): string {
	if (dollars > 0 && dollars < 0.005) return "<$0.01";
	return `$${dollars.toFixed(2)}`;
}

/** A cost as it shows: dollars, "Price unknown" or "Not reported" (REP-56, REP-57). */
export function costText(cost: Cost): string {
	switch (cost.kind) {
		case "not-reported":
			return "Not reported";
		case "old":
			return `${tokenCount.format(cost.tokens)} tokens`;
		case "reported":
			return cost.dollars ? formatDollars(totalOf(cost.dollars)) : "Price unknown";
	}
}

/** What hovering a cost shows: the model and the four parts, each with its dollars when the model has a price (REP-57). */
export function costParts(cost: Cost): string[] {
	switch (cost.kind) {
		case "not-reported":
			return ["The agent reported no tokens."];
		case "old":
			return [`${tokenCount.format(cost.tokens)} tokens in all. Reports from before tokens were kept in four parts have no price.`];
		case "reported": {
			const lines = [`Model: ${cost.models.length > 0 ? cost.models.join(", ") : "not named by the agent"}`];
			if (!cost.dollars) lines.push("Price unknown: add the model under Model prices in theory.md settings.");
			for (const part of PARTS) {
				const tokens = `${PART_NAMES[part]}: ${tokenCount.format(cost.parts[part])} tokens`;
				lines.push(cost.dollars ? `${tokens} (${formatDollars(cost.dollars[part])})` : tokens);
			}
			return lines;
		}
	}
}

/** The hover text of a cost in the report (REP-57). */
export function costTitle(name: string, cost: Cost): string {
	return [`${name}: ${costText(cost)}`, ...costParts(cost)].join("\n");
}

/**
 * The report's cost line (REP-57): the compile's cost, and once a build ran, the build's apart and their total. Each
 * piece has the text it shows and what hovering it shows. Before any build, the total would only repeat the compile's.
 */
export function reportCostPieces(costs: ReportCosts): { label: string; text: string; title: string }[] {
	const piece = (label: string, cost: Cost) => ({ label, text: costText(cost), title: costTitle(label, cost) });
	if (!costs.build) return [piece("Compile", costs.compile)];
	return [piece("Compile", costs.compile), piece("Build", costs.build), piece("Total", costs.total)];
}

/** The hover text of a compile's cost in compile history: the compile and the build apart, with their parts (UI-16). */
export function historyCostTitle(costs: ReportCosts): string {
	const sections = [costTitle("Compile", costs.compile)];
	if (costs.build) sections.push(costTitle("Build", costs.build));
	return sections.join("\n\n");
}

/**
 * The Model prices list as saved in plugin data (CFG-48): rows without a model name are dropped, and a price that
 * isn't a number of zero or more reads as 0. Empty by default.
 */
export function savedModelPrices(value: unknown): ModelPrice[] {
	if (!Array.isArray(value)) return [];
	const prices: ModelPrice[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		if (typeof e.model !== "string" || !e.model.trim()) continue;
		prices.push({ model: e.model.trim(), input: count(e.input), output: count(e.output), cacheWrites: count(e.cacheWrites), cacheReads: count(e.cacheReads) });
	}
	return prices;
}

/** A price typed in the settings: a number of dollars per million tokens, or null when it isn't one. */
export function parsePrice(text: string): number | null {
	const trimmed = text.trim().replace(/^\$/, "");
	if (!/^\d+(?:\.\d+)?$|^\.\d+$/.test(trimmed)) return null;
	return Number(trimmed);
}
