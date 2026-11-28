import { describe, expect, it } from "vitest";
import {
	type LaunchStorage,
	corePluginOn,
	firstLoadInWindow,
	graphTabTarget,
	launchTab,
	leafViewType,
	noteTabTarget,
	pickGraphLeaf,
	runsLaunchLayout,
} from "../src/launch";

/** A window's sessionStorage, as a plain map. */
function memoryStorage(): LaunchStorage & { items: Map<string, string> } {
	const items = new Map<string, string>();
	return {
		items,
		getItem: (key) => items.get(key) ?? null,
		setItem: (key, value) => void items.set(key, value),
	};
}

describe("when the launch layout runs (UI-33)", () => {
	it("runs on a launch, the first time the vault loads in the window", () => {
		expect(runsLaunchLayout(false, true)).toBe(true);
	});

	it("never runs when the plugin is turned on mid-session", () => {
		expect(runsLaunchLayout(true, true)).toBe(false);
	});

	it("never runs when the vault is reopened in the same window", () => {
		expect(runsLaunchLayout(false, false)).toBe(false);
	});

	it("counts only the first load of a vault in a window", () => {
		const storage = memoryStorage();
		expect(firstLoadInWindow(storage, "/vaults/model")).toBe(true);
		expect(firstLoadInWindow(storage, "/vaults/model")).toBe(false);
		expect(firstLoadInWindow(storage, "/vaults/model")).toBe(false);
	});

	it("counts each vault on its own", () => {
		const storage = memoryStorage();
		expect(firstLoadInWindow(storage, "/vaults/model")).toBe(true);
		expect(firstLoadInWindow(storage, "/vaults/other")).toBe(true);
		expect(firstLoadInWindow(storage, "/vaults/model")).toBe(false);
	});

	it("counts as a launch when there is no storage or it fails", () => {
		expect(firstLoadInWindow(null, "/vaults/model")).toBe(true);
		const broken: LaunchStorage = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
		};
		expect(firstLoadInWindow(broken, "/vaults/model")).toBe(true);
		const readOnly: LaunchStorage = {
			getItem: () => null,
			setItem: () => {
				throw new Error("quota");
			},
		};
		expect(firstLoadInWindow(readOnly, "/vaults/model")).toBe(true);
	});
});

describe("the tab a launch opens (UI-1, UI-34)", () => {
	it("opens Graph view when no Graph view tab is open, even when Index.md exists", () => {
		expect(launchTab({ graphOn: true, graphTabOpen: false, indexExists: true })).toBe("open-graph");
		expect(launchTab({ graphOn: true, graphTabOpen: false, indexExists: false })).toBe("open-graph");
	});

	it("makes the Graph view tab from the last session active instead of opening a second one", () => {
		expect(launchTab({ graphOn: true, graphTabOpen: true, indexExists: true })).toBe("show-graph");
	});

	it("opens Index.md when Graph view is off", () => {
		expect(launchTab({ graphOn: false, graphTabOpen: false, indexExists: true })).toBe("open-index");
		expect(launchTab({ graphOn: false, graphTabOpen: true, indexExists: true })).toBe("open-index");
	});

	it("opens no tab when Graph view is off and there is no Index.md", () => {
		expect(launchTab({ graphOn: false, graphTabOpen: false, indexExists: false })).toBe("none");
	});

	it("puts a new Graph view in an empty tab, and in a new tab otherwise so other tabs stay open", () => {
		expect(graphTabTarget("empty")).toBe("reuse");
		expect(graphTabTarget("markdown")).toBe("new");
		expect(graphTabTarget("theory-report")).toBe("new");
		expect(graphTabTarget(null)).toBe("new");
	});

	it("prefers a Graph view tab in the main area", () => {
		const leaves = [{ id: "sidebar", main: false }, { id: "main", main: true }];
		expect(pickGraphLeaf(leaves, (leaf) => leaf.main)?.id).toBe("main");
		expect(pickGraphLeaf([leaves[0]], (leaf) => leaf.main)?.id).toBe("sidebar");
		expect(pickGraphLeaf([], () => true)).toBeNull();
	});
});

describe("Setup vault's note after Graph view (UI-35)", () => {
	it("opens the note in a new tab when Graph view is the active tab", () => {
		expect(noteTabTarget("graph")).toBe("new");
	});

	it("opens it as before otherwise", () => {
		expect(noteTabTarget("markdown")).toBe("reuse");
		expect(noteTabTarget("empty")).toBe("reuse");
		expect(noteTabTarget(null)).toBe("reuse");
	});
});

describe("whether a core plugin is on", () => {
	it("reads Obsidian's internal plugins", () => {
		const app = { internalPlugins: { getPluginById: (id: string) => ({ enabled: id === "graph" }) } };
		expect(corePluginOn(app, "graph")).toBe(true);
		expect(corePluginOn(app, "file-explorer")).toBe(false);
		expect(corePluginOn({ internalPlugins: { getPluginById: () => null } }, "graph")).toBe(false);
	});

	it("falls back to the plugin list, then to the registered views", () => {
		expect(corePluginOn({ internalPlugins: { plugins: { graph: { enabled: true } } } }, "graph")).toBe(true);
		expect(corePluginOn({ internalPlugins: { plugins: { graph: { enabled: false } } } }, "graph")).toBe(false);
		expect(corePluginOn({ viewRegistry: { viewByType: { graph: () => null } } }, "graph")).toBe(true);
		expect(corePluginOn({ viewRegistry: { viewByType: {} } }, "graph")).toBe(false);
	});

	it("counts as off when the private API is missing or throws", () => {
		expect(corePluginOn({}, "graph")).toBe(false);
		expect(corePluginOn(null, "graph")).toBe(false);
		const throwing = {
			internalPlugins: {
				getPluginById: () => {
					throw new Error("changed");
				},
			},
		};
		expect(corePluginOn(throwing, "graph")).toBe(false);
	});
});

describe("a leaf's view type", () => {
	it("reads the view state, so a deferred tab still has its type", () => {
		const leaf = { getViewState: () => ({ type: "graph" }) };
		expect(leafViewType(leaf as never)).toBe("graph");
		expect(leafViewType(null)).toBeNull();
		const broken = {
			getViewState: () => {
				throw new Error("gone");
			},
		};
		expect(leafViewType(broken as never)).toBeNull();
	});
});
