import { type App, TFile, type WorkspaceLeaf } from "obsidian";

// The workspace theory.md sets up when Obsidian launches (UI-1, UI-32 to UI-35). The decisions are plain
// functions so they can be tested; `openLaunchLayout` applies them, and is checked by hand in Obsidian.

/** Graph view's view type and core plugin id. */
export const GRAPH_VIEW_TYPE = "graph";
/** The file explorer's view type and core plugin id. */
export const FILE_EXPLORER_VIEW_TYPE = "file-explorer";
/** Obsidian's view type for an empty tab ("New tab"). */
export const EMPTY_VIEW_TYPE = "empty";

const LAUNCH_KEY = "theory-launched:";

/** The part of the browser's `Storage` the launch check needs. */
export type LaunchStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Whether this is the first time `vault` loads in this window, and remembers that it loaded (UI-33).
 * `sessionStorage` belongs to one window and survives a reload, so a vault reopened in the same window
 * finds its mark and doesn't count as a launch. Without storage, or when it fails, it counts as a launch.
 */
export function firstLoadInWindow(storage: LaunchStorage | null, vault: string): boolean {
	if (!storage) return true;
	const key = LAUNCH_KEY + vault;
	try {
		if (storage.getItem(key) !== null) return false;
		storage.setItem(key, "1");
	} catch {
		// Storage can be blocked; a launch layout too many is better than none.
	}
	return true;
}

/** The window's `sessionStorage`, or null when there is none or it can't be read. */
export function windowSessionStorage(): LaunchStorage | null {
	try {
		return typeof sessionStorage === "undefined" ? null : sessionStorage;
	} catch {
		return null;
	}
}

/**
 * Whether the launch layout runs (UI-33): only on a launch, so when the layout wasn't ready yet as the plugin
 * loaded (not turned on mid-session), and only the first time the vault loads in this window.
 */
export function runsLaunchLayout(layoutReadyAtLoad: boolean, firstInWindow: boolean): boolean {
	return !layoutReadyAtLoad && firstInWindow;
}

/** What the main area shows on launch. */
export type LaunchTab =
	/** A Graph view tab from the last session becomes active; no second one opens (UI-1). */
	| "show-graph"
	/** A new Graph view tab opens and becomes active (UI-1). */
	| "open-graph"
	/** Graph view is off: `Index.md` opens as the active tab (UI-34). */
	| "open-index"
	/** Graph view is off and there is no `Index.md`: no tab opens (UI-34). */
	| "none";

export function launchTab(state: { graphOn: boolean; graphTabOpen: boolean; indexExists: boolean }): LaunchTab {
	if (state.graphOn) return state.graphTabOpen ? "show-graph" : "open-graph";
	return state.indexExists ? "open-index" : "none";
}

/**
 * Where a new Graph view tab goes: into the active tab when that is an empty "New tab", else a new tab, so
 * the other tabs from the last session stay open behind it (UI-1).
 */
export function graphTabTarget(activeViewType: string | null): "reuse" | "new" {
	return activeViewType === EMPTY_VIEW_TYPE ? "reuse" : "new";
}

/**
 * Where Setup vault opens `_welcome.md` or `Index.md`: in a new tab when the active tab is Graph view, so the
 * note opens after the graph instead of replacing it (UI-35), else as Obsidian opens a note.
 */
export function noteTabTarget(activeViewType: string | null): "reuse" | "new" {
	return activeViewType === GRAPH_VIEW_TYPE ? "new" : "reuse";
}

/** The Graph view tab to make active: the first one in the main area, else the first anywhere. */
export function pickGraphLeaf<T>(leaves: T[], inMainArea: (leaf: T) => boolean): T | null {
	return leaves.find(inMainArea) ?? leaves[0] ?? null;
}

interface InternalPlugins {
	getPluginById?: (id: string) => { enabled?: boolean } | null | undefined;
	plugins?: Record<string, { enabled?: boolean } | undefined>;
}

/**
 * Whether the core plugin `id` is on, which also says whether its view can open. Obsidian has no public API
 * for this, so it reads the private `internalPlugins` and, failing that, the private view registry. Anything
 * unexpected counts as off, so a launch never opens a view that isn't there (UI-34).
 */
export function corePluginOn(app: unknown, id: string): boolean {
	try {
		const internal = (app as { internalPlugins?: InternalPlugins }).internalPlugins;
		if (typeof internal?.getPluginById === "function") return internal.getPluginById(id)?.enabled === true;
		if (internal?.plugins) return internal.plugins[id]?.enabled === true;
		const registry = (app as { viewRegistry?: { viewByType?: Record<string, unknown> } }).viewRegistry;
		if (registry?.viewByType) return Object.prototype.hasOwnProperty.call(registry.viewByType, id);
	} catch {
		// Private API changed: count it as off.
	}
	return false;
}

/** A leaf's view type, the real one even while Obsidian defers loading its view. */
export function leafViewType(leaf: WorkspaceLeaf | null): string | null {
	if (!leaf) return null;
	try {
		return leaf.getViewState().type ?? null;
	} catch {
		return null;
	}
}

/** Runs one step of the layout. A step that fails is skipped: a launch must never fail (UI-34). */
async function quietly(step: () => unknown): Promise<void> {
	try {
		await step();
	} catch (error) {
		console.warn("theory.md: launch layout step failed", error);
	}
}

/**
 * Sets up the workspace on launch, after Obsidian restored the last layout (UI-33): both sidebars expanded,
 * the file explorer on the left and the Comments view as the right sidebar's active tab (UI-32), then Graph
 * view as the active tab, or `Index.md` when Graph view is off (UI-1, UI-34). The Comments view must already
 * be in the right sidebar.
 */
export async function openLaunchLayout(app: App, options: { commentsViewType: string; openIndex: () => Promise<void> }) {
	const { workspace, vault } = app;

	// UI-32: both sidebars, the file explorer on the left and Comments on the right.
	await quietly(() => workspace.leftSplit.expand());
	await quietly(() => workspace.rightSplit.expand());
	await quietly(async () => {
		let explorer: WorkspaceLeaf | null = workspace.getLeavesOfType(FILE_EXPLORER_VIEW_TYPE)[0] ?? null;
		if (!explorer && corePluginOn(app, FILE_EXPLORER_VIEW_TYPE)) {
			explorer = workspace.getLeftLeaf(false);
			await explorer?.setViewState({ type: FILE_EXPLORER_VIEW_TYPE, active: false });
		}
		if (explorer) await workspace.revealLeaf(explorer);
	});
	await quietly(async () => {
		const comments = workspace.getLeavesOfType(options.commentsViewType)[0];
		if (comments) await workspace.revealLeaf(comments);
	});

	// UI-1 and UI-34: the main area's active tab, last, so it ends up with the focus.
	await quietly(async () => {
		const graphs = workspace.getLeavesOfType(GRAPH_VIEW_TYPE);
		const tab = launchTab({
			graphOn: corePluginOn(app, GRAPH_VIEW_TYPE),
			graphTabOpen: graphs.length > 0,
			indexExists: vault.getRoot().children.some((child) => child instanceof TFile && child.name.toLowerCase() === "index.md"),
		});
		if (tab === "show-graph") {
			const leaf = pickGraphLeaf(graphs, (candidate) => candidate.getRoot() === workspace.rootSplit);
			if (!leaf) return;
			await workspace.revealLeaf(leaf);
			workspace.setActiveLeaf(leaf, { focus: true });
		} else if (tab === "open-graph") {
			const active = workspace.getMostRecentLeaf(workspace.rootSplit);
			const leaf = active && graphTabTarget(leafViewType(active)) === "reuse" ? active : workspace.getLeaf("tab");
			await leaf.setViewState({ type: GRAPH_VIEW_TYPE, active: true });
			workspace.setActiveLeaf(leaf, { focus: true });
		} else if (tab === "open-index") {
			await options.openIndex();
		}
	});
}
