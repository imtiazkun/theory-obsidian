// What theory.md sets up on the first load after install.sh (SET-20 to SET-25, UI-36 to UI-39, UI-43, UI-44),
// and again from the command "Use theory.md's core plugins". The decisions are plain functions so they can
// be tested; the Obsidian internals they act on are in `src/workspace-setup.ts`.

import type { MissingStarters } from "./vault";

/** The core plugins theory.md keeps on, in the order SET-21 lists them. Every other core plugin is turned off. */
export const THEORY_CORE_PLUGINS: readonly { id: string; name: string }[] = [
	{ id: "command-palette", name: "Command palette" },
	{ id: "file-recovery", name: "File recovery" },
	{ id: "file-explorer", name: "Files" },
	{ id: "graph", name: "Graph view" },
	{ id: "note-composer", name: "Note composer" },
	{ id: "page-preview", name: "Page preview" },
	{ id: "switcher", name: "Quick switcher" },
	{ id: "global-search", name: "Search" },
	{ id: "templates", name: "Templates" },
	{ id: "word-count", name: "Word count" },
];

/** A core plugin as Obsidian has it now. */
export interface CorePluginState {
	id: string;
	enabled: boolean;
}

/** What SET-21 changes: the plugins to turn on and off, and theory.md's plugins this Obsidian doesn't have. */
export interface CorePluginPlan {
	enable: string[];
	disable: string[];
	missing: string[];
}

/** Turns on exactly theory.md's core plugins and turns off every other one (SET-21). */
export function planCorePlugins(plugins: CorePluginState[]): CorePluginPlan {
	const wanted = new Set(THEORY_CORE_PLUGINS.map((plugin) => plugin.id));
	const present = new Set(plugins.map((plugin) => plugin.id));
	return {
		enable: plugins.filter((plugin) => wanted.has(plugin.id) && !plugin.enabled).map((plugin) => plugin.id),
		disable: plugins.filter((plugin) => !wanted.has(plugin.id) && plugin.enabled).map((plugin) => plugin.id),
		missing: THEORY_CORE_PLUGINS.filter((plugin) => !present.has(plugin.id)).map((plugin) => plugin.id),
	};
}

/** The notice after the core plugins were set (SET-22, SET-24), or null when nothing changed or failed. */
export function corePluginsNotice(turnedOff: number, failed: string[]): string | null {
	const parts: string[] = [];
	if (turnedOff > 0) {
		const plugins = turnedOff === 1 ? "core plugin" : "core plugins";
		parts.push(`theory.md turned off ${turnedOff} ${plugins} it doesn't use. Turn any back on in Settings → Core plugins.`);
	}
	if (failed.length > 0) parts.push(`Couldn't change: ${failed.join(", ")}.`);
	return parts.length > 0 ? parts.join(" ") : null;
}

/** "a, b and c". */
function listed(items: string[]): string {
	return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The question the command asks before it changes anything (SET-25). */
export function corePluginsQuestion(): string {
	return `Turn off every core plugin except ${listed(THEORY_CORE_PLUGINS.map((plugin) => plugin.name))}?`;
}

/** A Graph view colour group, as Obsidian keeps it in `graph.json`. */
export interface ColorGroup {
	query: string;
	color: { a: number; rgb: number };
}

/**
 * theory.md's colour groups, in this order (UI-36). Templates come first because Graph view uses the first
 * group that matches, so `_templates/index.md` stays grey (UI-37). Graph view's search ignores case.
 */
export const THEORY_COLOR_GROUPS: readonly ColorGroup[] = [
	{ query: "path:_templates/", color: { a: 1, rgb: 0x9e9e9e } },
	{ query: "file:/^index\\.md$/", color: { a: 1, rgb: 0x4a90e2 } },
	{ query: "file:/^instructions\\.md$/", color: { a: 1, rgb: 0x43a047 } },
];

function queryOf(group: unknown): string | null {
	if (typeof group !== "object" || group === null) return null;
	const query = (group as { query?: unknown }).query;
	return typeof query === "string" ? query.trim() : null;
}

/**
 * theory.md's groups first, in order, then every other group the engineer made, in their order (UI-38).
 * A group whose query is there already is kept as it is, with the engineer's colour.
 */
export function mergeColorGroups(existing: unknown): unknown[] {
	const groups: unknown[] = Array.isArray(existing) ? existing : [];
	const used = new Set<unknown>();
	const merged: unknown[] = THEORY_COLOR_GROUPS.map((ours) => {
		const theirs = groups.find((group) => !used.has(group) && queryOf(group) === ours.query);
		if (theirs === undefined) return { query: ours.query, color: { ...ours.color } };
		used.add(theirs);
		return theirs;
	});
	return [...merged, ...groups.filter((group) => !used.has(group))];
}

/** The ribbon button title of the Repositories page (UI-8). */
export const REPOSITORIES_RIBBON_TITLE = "Show repositories";

/**
 * The left ribbon's order, top to bottom (UI-43): Open graph view, Open quick switcher, Insert template,
 * Open command palette and Repositories, then every other button in Obsidian's order. Obsidian names a
 * ribbon button `{plugin id}:{title}`; core plugins' titles follow Obsidian's language, so a core button is
 * found by its plugin id when its English title isn't there. A button that isn't in the ribbon is skipped.
 */
export function ribbonOrder(ids: string[], pluginId: string): string[] {
	const wanted: { exact: string; prefix?: string }[] = [
		{ exact: "graph:Open graph view", prefix: "graph:" },
		{ exact: "switcher:Open quick switcher", prefix: "switcher:" },
		{ exact: "templates:Insert template", prefix: "templates:" },
		{ exact: "command-palette:Open command palette", prefix: "command-palette:" },
		{ exact: `${pluginId}:${REPOSITORIES_RIBBON_TITLE}` },
	];
	const first: string[] = [];
	for (const { exact, prefix } of wanted) {
		const id =
			ids.find((id) => id === exact && !first.includes(id)) ??
			(prefix === undefined ? undefined : ids.find((id) => id.startsWith(prefix) && !first.includes(id)));
		if (id !== undefined) first.push(id);
	}
	return [...first, ...ids.filter((id) => !first.includes(id))];
}

/** The steps of a first load (SET-20). */
export interface FirstLoadSteps {
	/** Drops the request from plugin data. */
	dropRequest(): Promise<void>;
	/** Step 1: the core plugins (SET-21), with the ribbon order (UI-43) and the graph colour groups (UI-38). */
	setCorePlugins(): Promise<void>;
	/** Step 2: Setup vault, which leaves a vault with git as it is (SET-2). */
	setUpVault(): Promise<void>;
}

/**
 * Runs a first load once, in order (SET-20). The request is dropped before step 1, so a step that fails never
 * runs again by itself; a request that can't be dropped runs nothing, so the first load is tried again on the
 * next launch rather than twice. Step 1 failing never stops step 2 (SET-24).
 */
export async function runFirstLoad(steps: FirstLoadSteps): Promise<void> {
	await steps.dropRequest();
	try {
		await steps.setCorePlugins();
	} catch {
		// Setup vault matters more than a tidy sidebar.
	}
	await steps.setUpVault();
}

/** The notice for a first load in a vault that already uses git (SET-20 step 2), or null when nothing is missing. */
export function missingStartersNotice(missing: MissingStarters): string | null {
	const names = missing.files.map((file) => file.path);
	if (missing.gitignoreLines.length > 0) names.push(`.gitignore lines (${missing.gitignoreLines.join(", ")})`);
	if (names.length === 0) return null;
	return `theory.md is installed. This vault already uses git, so it was left as it is. It's missing ${listed(names)}. Settings → theory.md can add them.`;
}
