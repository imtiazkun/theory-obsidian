import { describe, expect, it } from "vitest";
import {
	THEORY_COLOR_GROUPS,
	corePluginsNotice,
	corePluginsQuestion,
	mergeColorGroups,
	missingStartersNotice,
	planCorePlugins,
	ribbonOrder,
	runFirstLoad,
} from "../src/first-load";
import { addColorGroups, setCorePlugins, setRibbonOrder, useTheoryWorkspace } from "../src/workspace-setup";

const THEORY_IDS = [
	"command-palette",
	"file-recovery",
	"file-explorer",
	"graph",
	"note-composer",
	"page-preview",
	"switcher",
	"global-search",
	"templates",
	"word-count",
];

/** A stand-in for `app.internalPlugins`: each plugin turns on and off, and can be made to fail. */
function fakeCorePlugins(enabled: Record<string, boolean>, options: { failing?: string[]; andSave?: boolean } = {}) {
	const saved: string[] = [];
	const plugins: Record<string, { enabled: boolean; enable(save: boolean): void; disable(save: boolean): void }> = {};
	for (const [id, on] of Object.entries(enabled)) {
		plugins[id] = {
			enabled: on,
			enable() {
				if (options.failing?.includes(id)) throw new Error("can't");
				this.enabled = true;
			},
			disable() {
				if (options.failing?.includes(id)) throw new Error("can't");
				this.enabled = false;
			},
		};
	}
	const manager: Record<string, unknown> = { plugins, saveConfig: () => saved.push("config") };
	if (options.andSave) {
		manager.enablePluginAndSave = async (id: string) => {
			plugins[id].enable(true);
			saved.push(id);
		};
		manager.disablePluginAndSave = async (id: string) => {
			plugins[id].disable(true);
			saved.push(id);
		};
	}
	return { app: { internalPlugins: manager }, plugins, saved };
}

describe("core plugins (SET-21, SET-22, SET-24)", () => {
	it("turns on exactly theory.md's core plugins and turns off every other one", () => {
		const plan = planCorePlugins([
			{ id: "graph", enabled: false },
			{ id: "templates", enabled: true },
			{ id: "backlink", enabled: true },
			{ id: "daily-notes", enabled: false },
			{ id: "canvas", enabled: true },
			...THEORY_IDS.filter((id) => !["graph", "templates"].includes(id)).map((id) => ({ id, enabled: true })),
		]);
		expect(plan).toEqual({ enable: ["graph"], disable: ["backlink", "canvas"], missing: [] });
	});

	it("names theory.md's core plugins this Obsidian doesn't have", () => {
		const plan = planCorePlugins([{ id: "graph", enabled: true }]);
		expect(plan.missing).toEqual(THEORY_IDS.filter((id) => id !== "graph"));
	});

	it("says how many it turned off, and which it couldn't change", () => {
		expect(corePluginsNotice(3, [])).toBe(
			"theory.md turned off 3 core plugins it doesn't use. Turn any back on in Settings → Core plugins.",
		);
		expect(corePluginsNotice(2, ["Canvas", "Backlinks"])).toBe(
			"theory.md turned off 2 core plugins it doesn't use. Turn any back on in Settings → Core plugins. Couldn't change: Canvas, Backlinks.",
		);
		expect(corePluginsNotice(0, ["Canvas"])).toBe("Couldn't change: Canvas.");
		expect(corePluginsNotice(0, [])).toBeNull();
	});

	it("asks before the command changes anything (SET-25)", () => {
		expect(corePluginsQuestion()).toBe(
			"Turn off every core plugin except Command palette, File recovery, Files, Graph view, Note composer, Page preview, Quick switcher, Search, Templates and Word count?",
		);
	});

	it("changes the core plugins at once and saves Obsidian's config", async () => {
		const enabled: Record<string, boolean> = { backlink: true, canvas: true, outline: false };
		for (const id of THEORY_IDS) enabled[id] = id !== "templates";
		const fake = fakeCorePlugins(enabled);
		expect(await setCorePlugins(fake.app)).toEqual({ turnedOff: 2, failed: [] });
		const on = Object.entries(fake.plugins).filter(([, p]) => p.enabled).map(([id]) => id);
		expect(on.sort()).toEqual([...THEORY_IDS].sort());
		expect(fake.saved).toEqual(["config"]);
	});

	it("uses Obsidian's enable-and-save when it has it", async () => {
		const fake = fakeCorePlugins({ graph: false, canvas: true }, { andSave: true });
		expect(await setCorePlugins(fake.app)).toMatchObject({ turnedOff: 1 });
		expect(fake.saved).toEqual(["graph", "canvas"]);
	});

	it("skips a core plugin that can't be changed and changes the rest", async () => {
		const enabled: Record<string, boolean> = { backlink: true, canvas: true, graph: false, templates: false };
		const fake = fakeCorePlugins(enabled, { failing: ["canvas", "graph"] });
		const result = await setCorePlugins(fake.app);
		expect(result.turnedOff).toBe(1);
		expect(result.failed).toContain("Graph view");
		expect(result.failed).toContain("canvas");
		expect(fake.plugins.backlink.enabled).toBe(false);
		expect(fake.plugins.templates.enabled).toBe(true);
		expect(fake.plugins.canvas.enabled).toBe(true);
	});

	it("never throws when Obsidian has no core plugins it can read", async () => {
		expect(await setCorePlugins({})).toEqual({ turnedOff: 0, failed: ["core plugins"] });
		expect(await useTheoryWorkspace({}, "theory-md")).toEqual({ turnedOff: 0, failed: ["core plugins"] });
	});
});

describe("ribbon order (UI-43, UI-44)", () => {
	const obsidian = [
		"other-plugin:Do more",
		"canvas:Create new canvas",
		"command-palette:Open command palette",
		"graph:Open graph view",
		"theory-md:Show repositories",
		"other-plugin:Do things",
		"templates:Insert template",
		"switcher:Open quick switcher",
	];

	it("puts theory.md's buttons first, in order, and the rest after in Obsidian's order", () => {
		expect(ribbonOrder(obsidian, "theory-md")).toEqual([
			"graph:Open graph view",
			"switcher:Open quick switcher",
			"templates:Insert template",
			"command-palette:Open command palette",
			"theory-md:Show repositories",
			"other-plugin:Do more",
			"canvas:Create new canvas",
			"other-plugin:Do things",
		]);
	});

	it("skips a button that isn't there, and finds a core button whose title is translated", () => {
		expect(ribbonOrder(["a:One", "graph:Graphe", "theory-md:Show repositories"], "theory-md")).toEqual([
			"graph:Graphe",
			"theory-md:Show repositories",
			"a:One",
		]);
	});

	/** A ribbon with buttons in a parent element, as far as setRibbonOrder looks at them. */
	function fakeRibbon(ids: string[], options: { hidden?: string[]; failSave?: boolean } = {}) {
		const children: unknown[] = [];
		const parent = {
			insertBefore(el: { parentElement: unknown }, anchor: unknown) {
				const at = children.indexOf(el);
				if (at >= 0) children.splice(at, 1);
				const to = anchor === null ? children.length : children.indexOf(anchor);
				children.splice(to, 0, el);
				el.parentElement = parent;
			},
		};
		const element = (name: string) => {
			const el = {
				name,
				parentElement: null as unknown,
				get nextSibling() {
					const at = children.indexOf(el);
					return at >= 0 && at + 1 < children.length ? children[at + 1] : null;
				},
			};
			return el;
		};
		const items = ids.map((id) => ({ id, buttonEl: element(id) }));
		for (const item of items) {
			if (options.hidden?.includes(item.id)) continue;
			children.push(item.buttonEl);
			item.buttonEl.parentElement = parent;
		}
		const tail = element("settings");
		children.push(tail);
		tail.parentElement = parent;
		let saves = 0;
		const app = {
			workspace: {
				leftRibbon: { items },
				requestSaveLayout: () => {
					if (options.failSave) throw new Error("no");
					saves++;
				},
			},
		};
		return {
			app,
			itemIds: () => items.map((item) => item.id),
			dom: () => children.map((el) => (el as { name: string }).name),
			saves: () => saves,
		};
	}

	it("reorders the ribbon's items and buttons and saves the layout", () => {
		const ribbon = fakeRibbon(obsidian, { hidden: ["canvas:Create new canvas"] });
		expect(setRibbonOrder(ribbon.app, "theory-md")).toBe(true);
		const order = ribbonOrder(obsidian, "theory-md");
		expect(ribbon.itemIds()).toEqual(order);
		// A hidden button stays out of the ribbon, and other children keep their place.
		expect(ribbon.dom()).toEqual([...order.filter((id) => id !== "canvas:Create new canvas"), "settings"]);
		expect(ribbon.saves()).toBe(1);
	});

	it("leaves the ribbon in Obsidian's order when it can't be set", () => {
		const ribbon = fakeRibbon(obsidian, { failSave: true });
		expect(setRibbonOrder(ribbon.app, "theory-md")).toBe(false);
		expect(ribbon.itemIds()).toEqual(obsidian);
		expect(ribbon.dom()).toEqual([...obsidian, "settings"]);
		expect(setRibbonOrder({ workspace: {} }, "theory-md")).toBe(false);
		const twice = fakeRibbon(["a:One", "graph:Open graph view", "a:One"]);
		expect(setRibbonOrder(twice.app, "theory-md")).toBe(false);
		expect(twice.itemIds()).toEqual(["a:One", "graph:Open graph view", "a:One"]);
		expect(setRibbonOrder({ workspace: { leftRibbon: { items: [{}] }, requestSaveLayout() {} } }, "theory-md")).toBe(false);
	});
});

describe("graph colour groups (UI-36 to UI-39)", () => {
	const engineer = (query: string, rgb: number) => ({ query, color: { a: 1, rgb } });

	it("adds theory.md's groups in order to a graph without groups", () => {
		expect(mergeColorGroups(undefined)).toEqual(THEORY_COLOR_GROUPS);
		expect(THEORY_COLOR_GROUPS.map((group) => group.query)).toEqual([
			"path:_templates/",
			"file:/^index\\.md$/",
			"file:/^instructions\\.md$/",
		]);
	});

	it("keeps a group whose query is there with the engineer's colour, and every other group after", () => {
		const mine = engineer("tag:#draft", 1);
		const index = engineer("file:/^index\\.md$/", 2);
		const other = engineer("path:people/", 3);
		const merged = mergeColorGroups([mine, index, other]);
		expect(merged).toEqual([THEORY_COLOR_GROUPS[0], index, THEORY_COLOR_GROUPS[2], mine, other]);
		expect(merged[1]).toBe(index);
	});

	it("is the same the second time", () => {
		const once = mergeColorGroups([engineer("tag:#x", 5)]);
		expect(mergeColorGroups(once)).toEqual(once);
	});

	function fakeVault(files: Record<string, string>) {
		return {
			configDir: ".obsidian",
			adapter: {
				exists: async (path: string) => path in files,
				read: async (path: string) => files[path],
				write: async (path: string, data: string) => {
					files[path] = data;
				},
			},
		};
	}

	it("writes the groups into graph.json and keeps its other settings", async () => {
		const files = { ".obsidian/graph.json": JSON.stringify({ showTags: true, colorGroups: [engineer("tag:#x", 5)] }) };
		expect(await addColorGroups({ vault: fakeVault(files) })).toBe(true);
		const graph = JSON.parse(files[".obsidian/graph.json"]);
		expect(graph.showTags).toBe(true);
		expect(graph.colorGroups).toEqual([...THEORY_COLOR_GROUPS, engineer("tag:#x", 5)]);
	});

	it("gives Graph view's open settings the same groups, so it never saves over them", async () => {
		const files: Record<string, string> = {};
		const options: Record<string, unknown> = { colorGroups: [engineer("tag:#y", 6)] };
		let saved = 0;
		const graph = { enabled: true, instance: { options, saveOptions: async () => saved++ } };
		const app = { vault: fakeVault(files), internalPlugins: { plugins: { graph } } };
		expect(await addColorGroups(app)).toBe(true);
		expect(options.colorGroups).toEqual([...THEORY_COLOR_GROUPS, engineer("tag:#y", 6)]);
		expect(saved).toBe(1);
	});

	it("never overwrites a graph.json it can't read", async () => {
		const files = { ".obsidian/graph.json": "{ broken" };
		expect(await addColorGroups({ vault: fakeVault(files) })).toBe(false);
		expect(files[".obsidian/graph.json"]).toBe("{ broken");
		expect(await addColorGroups({})).toBe(false);
	});
});

describe("first load (SET-20, SET-24)", () => {
	it("drops the request before step 1, then sets the core plugins, then runs Setup vault", async () => {
		const steps: string[] = [];
		await runFirstLoad({
			dropRequest: async () => void steps.push("drop"),
			setCorePlugins: async () => void steps.push("core plugins"),
			setUpVault: async () => void steps.push("setup"),
		});
		expect(steps).toEqual(["drop", "core plugins", "setup"]);
	});

	it("runs Setup vault when the core plugins fail", async () => {
		const steps: string[] = [];
		await runFirstLoad({
			dropRequest: async () => void steps.push("drop"),
			setCorePlugins: async () => {
				throw new Error("no core plugins");
			},
			setUpVault: async () => void steps.push("setup"),
		});
		expect(steps).toEqual(["drop", "setup"]);
	});

	it("runs nothing when the request can't be dropped", async () => {
		const steps: string[] = [];
		await expect(
			runFirstLoad({
				dropRequest: async () => {
					throw new Error("disk full");
				},
				setCorePlugins: async () => void steps.push("core plugins"),
				setUpVault: async () => void steps.push("setup"),
			}),
		).rejects.toThrow("disk full");
		expect(steps).toEqual([]);
	});

	it("says which starter files a vault with git is missing", () => {
		const file = (path: string) => ({ path, sameAs: [path], content: "" });
		expect(missingStartersNotice({ files: [file("Index.md"), file("_templates/index.md")], gitignoreLines: [".obsidian/"] })).toBe(
			"theory.md is installed. This vault already uses git, so it was left as it is. It's missing Index.md, _templates/index.md and .gitignore lines (.obsidian/). Settings → theory.md can add them.",
		);
		expect(missingStartersNotice({ files: [], gitignoreLines: [] })).toBeNull();
	});
});
