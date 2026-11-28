// Obsidian keeps core plugins, the ribbon order and Graph view's open settings in private API with no public
// equivalent. Every touch of it is here: each function checks the shape it needs first, and fails quietly
// (SET-24, UI-44). The decisions are in `src/first-load.ts`.

import { THEORY_CORE_PLUGINS, mergeColorGroups, planCorePlugins, ribbonOrder } from "./first-load";

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
	return typeof value === "object" && value !== null;
}

function call(target: Rec, name: string, ...args: unknown[]): unknown {
	const fn = target[name];
	if (typeof fn !== "function") throw new Error(`no ${name}`);
	return (fn as (...a: unknown[]) => unknown).apply(target, args);
}

/** `app.internalPlugins`, Obsidian's core plugins, when it has the shape theory.md knows. */
function internalPlugins(app: unknown): { manager: Rec; plugins: Rec } | null {
	const manager = isRecord(app) ? app.internalPlugins : null;
	if (!isRecord(manager) || !isRecord(manager.plugins)) return null;
	return { manager, plugins: manager.plugins };
}

/** A core plugin's display name, else its id. */
function pluginName(id: string, plugin: unknown): string {
	const known = THEORY_CORE_PLUGINS.find((p) => p.id === id);
	if (known) return known.name;
	const instance = isRecord(plugin) ? plugin.instance : null;
	const name = isRecord(instance) ? instance.name : null;
	return typeof name === "string" && name !== "" ? name : id;
}

export interface CorePluginsResult {
	turnedOff: number;
	/** The names of the core plugins that couldn't be changed (SET-24). */
	failed: string[];
}

/**
 * Turns on exactly theory.md's core plugins and turns off the rest, at once, with no reload (SET-21, SET-22).
 * A plugin that can't be changed is skipped and named (SET-24). Never throws.
 */
export async function setCorePlugins(app: unknown): Promise<CorePluginsResult> {
	const found = internalPlugins(app);
	if (!found) return { turnedOff: 0, failed: ["core plugins"] };
	const { manager, plugins } = found;
	const states = Object.entries(plugins)
		.filter(([, plugin]) => isRecord(plugin))
		.map(([id, plugin]) => ({ id, enabled: (plugin as Rec).enabled === true }));
	const plan = planCorePlugins(states);
	const failed: string[] = plan.missing.map((id) => pluginName(id, null));
	let turnedOff = 0;
	let unsaved = false;
	const change = async (id: string, on: boolean) => {
		const plugin = plugins[id] as Rec;
		try {
			const andSave = on ? "enablePluginAndSave" : "disablePluginAndSave";
			if (typeof manager[andSave] === "function") {
				await call(manager, andSave, id);
			} else {
				await call(plugin, on ? "enable" : "disable", true);
				unsaved = true;
			}
			if (plugin.enabled !== on) throw new Error("unchanged");
			if (!on) turnedOff++;
		} catch {
			failed.push(pluginName(id, plugin));
		}
	};
	for (const id of plan.enable) await change(id, true);
	for (const id of plan.disable) await change(id, false);
	if (unsaved) {
		try {
			await call(manager, "saveConfig");
		} catch {
			// The plugins are changed for this session; Obsidian saves its config again on its own changes.
		}
	}
	return { turnedOff, failed };
}

interface RibbonItem {
	id: string;
	buttonEl?: unknown;
}

interface Element {
	parentElement: unknown;
	nextSibling: unknown;
}

function isElement(value: unknown): value is Element {
	return isRecord(value) && "parentElement" in value && "nextSibling" in value;
}

/**
 * Sets the left ribbon to theory.md's order (UI-43): reorders the ribbon's items, moves their buttons, and
 * asks Obsidian to save the layout, which keeps the order. When the ribbon doesn't have the shape theory.md
 * knows, or anything fails, it stays in Obsidian's order and nothing else changes (UI-44). Never throws.
 */
export function setRibbonOrder(app: unknown, pluginId: string): boolean {
	const workspace = isRecord(app) ? app.workspace : null;
	const ribbon = isRecord(workspace) ? workspace.leftRibbon : null;
	const items = isRecord(ribbon) ? ribbon.items : null;
	if (!Array.isArray(items) || !items.every((item) => isRecord(item) && typeof item.id === "string")) return false;
	if (typeof (workspace as Rec).requestSaveLayout !== "function") return false;
	const before = [...(items as RibbonItem[])];
	if (new Set(before.map((item) => item.id)).size !== before.length) return false;
	// Only buttons that are in the ribbon now move; a hidden one Obsidian took out stays out.
	const shown = before.map((item) => item.buttonEl).filter(isElement);
	const parent = shown.find((el) => isRecord(el.parentElement))?.parentElement;
	const attached = shown.filter((el) => parent !== undefined && el.parentElement === parent);
	if (attached.length > 0 && !(isRecord(parent) && typeof parent.insertBefore === "function")) return false;

	const order = ribbonOrder(before.map((item) => item.id), pluginId);
	const after = order.map((id) => before.find((item) => item.id === id) as RibbonItem);
	// The buttons go back in before the first sibling after them that isn't one of them, so the ribbon's
	// other children keep their place.
	const buttons = new Set<unknown>(attached);
	let anchor: unknown = attached.length > 0 ? attached[attached.length - 1].nextSibling : null;
	while (isElement(anchor) && buttons.has(anchor)) anchor = anchor.nextSibling;
	const place = (list: RibbonItem[]) => {
		for (const item of list) {
			if (buttons.has(item.buttonEl)) call(parent as Rec, "insertBefore", item.buttonEl, anchor ?? null);
		}
	};
	try {
		items.splice(0, items.length, ...after);
		place(after);
		call(workspace as Rec, "requestSaveLayout");
		return true;
	} catch {
		try {
			items.splice(0, items.length, ...before);
			place(before);
		} catch {
			// Nothing more can be put back.
		}
		return false;
	}
}

/** The minimum of `app.vault` this needs: public API, but checked so a test can pass a fake. */
interface VaultLike {
	configDir: string;
	adapter: {
		exists(path: string): Promise<boolean>;
		read(path: string): Promise<string>;
		write(path: string, data: string): Promise<void>;
	};
}

function vaultOf(app: unknown): VaultLike | null {
	const vault = isRecord(app) ? app.vault : null;
	if (!isRecord(vault) || typeof vault.configDir !== "string" || !isRecord(vault.adapter)) return null;
	const adapter = vault.adapter;
	if (!["exists", "read", "write"].every((name) => typeof adapter[name] === "function")) return null;
	return vault as unknown as VaultLike;
}

/**
 * Adds theory.md's colour groups to Graph view's settings (UI-36 to UI-38). Graph view keeps its settings
 * in `graph.json` and, while it's on, a copy in memory that it saves over the file; both get the same
 * groups. It never draws on the graph and never changes a note (UI-39). A `graph.json` that can't be read
 * is never overwritten. Never throws.
 */
export async function addColorGroups(app: unknown): Promise<boolean> {
	try {
		const vault = vaultOf(app);
		if (!vault) return false;
		const path = `${vault.configDir}/graph.json`;
		let data: Rec = {};
		if (await vault.adapter.exists(path)) {
			const parsed: unknown = JSON.parse(await vault.adapter.read(path));
			if (!isRecord(parsed) || Array.isArray(parsed)) return false;
			data = parsed;
		}
		const graph = internalPlugins(app)?.plugins.graph;
		const instance = isRecord(graph) && graph.enabled === true && isRecord(graph.instance) ? graph.instance : null;
		const options = instance && isRecord(instance.options) ? instance.options : null;
		const groups = mergeColorGroups(options && Array.isArray(options.colorGroups) ? options.colorGroups : data.colorGroups);
		if (options && typeof instance?.saveOptions === "function") {
			options.colorGroups = groups;
			await call(instance, "saveOptions");
			return true;
		}
		await vault.adapter.write(path, JSON.stringify({ ...data, colorGroups: groups }, null, 2));
		if (options) options.colorGroups = groups;
		return true;
	} catch {
		return false;
	}
}

/** Step 1 of a first load, and the command "Use theory.md's core plugins" (SET-21, UI-43, UI-38). */
export async function useTheoryWorkspace(app: unknown, pluginId: string): Promise<CorePluginsResult> {
	const result = await setCorePlugins(app);
	// After the core plugins, so the buttons of the ones just turned on are in the ribbon.
	setRibbonOrder(app, pluginId);
	await addColorGroups(app);
	return result;
}
