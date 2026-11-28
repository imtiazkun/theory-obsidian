import { TAbstractFile, TFolder, View, getIcon, getIconIds } from "obsidian";
import { projectRepos } from "./branches";
import { ChangeDot, DOT_TOOLTIPS, changeDots, isOrange, readDotState } from "./change-dots";
import type TheoryPlugin from "./main";

/** Folders whose name starts with this are hidden folders, like `_templates`. */
const HIDDEN_PREFIX = "_";

function isHiddenFolder(file: TAbstractFile): boolean {
	return file instanceof TFolder && file.name.startsWith(HIDDEN_PREFIX);
}

// The file explorer isn't in Obsidian's public types. It sorts each folder with this method.
interface ExplorerItem {
	file: TAbstractFile;
}
interface FileExplorerView extends View {
	getSortedFolderItems(folder: TFolder): ExplorerItem[];
	requestSort?(): void;
}

/**
 * Sorts hidden folders below everything else in the file explorer. Their grey text is in
 * styles.css. Each explorer gets its own wrapper, and unloading the plugin removes it.
 */
export class HiddenFolders {
	private patched = new Set<FileExplorerView>();

	constructor(private plugin: TheoryPlugin) {}

	/** Wraps any file explorer that isn't wrapped yet, e.g. after the layout changes. */
	attach() {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType("file-explorer")) {
			const view = leaf.view as FileExplorerView;
			if (this.patched.has(view) || typeof view.getSortedFolderItems !== "function") continue;
			const original = view.getSortedFolderItems;
			view.getSortedFolderItems = function (folder: TFolder) {
				const items = original.call(this, folder);
				// A stable partition keeps Obsidian's own order within each group.
				return [
					...items.filter((item) => !isHiddenFolder(item.file)),
					...items.filter((item) => isHiddenFolder(item.file)),
				];
			};
			this.patched.add(view);
			view.requestSort?.();
		}
	}

	detach() {
		for (const view of this.patched) {
			// The wrapper is an own property, so deleting it brings back the prototype's method.
			delete (view as Partial<FileExplorerView>).getSortedFolderItems;
			view.requestSort?.();
		}
		this.patched.clear();
	}
}

/** The icon beside each entry file: a house for index, a scroll for instructions. Names match ignoring case. */
const ENTRY_ICONS: Record<string, string[]> = { "index.md": ["house", "home"], "instructions.md": ["scroll"] };

/** The icon beside each model folder: the commit history view's icon (UI-40). */
const MODEL_FOLDER_ICON = ["history"];

/** The first of `names` this Obsidian version has, since Lucide renames icons between versions. */
function firstIcon(names: string[]): string {
	const ids = getIconIds();
	return names.find((icon) => ids.includes(`lucide-${icon}`)) ?? names[names.length - 1];
}

/** A quoted CSS string, for an attribute selector. */
function cssString(value: string): string {
	return `"${value.replace(/["\\]/g, "\\$&").replace(/\n/g, "\\a ")}"`;
}

/** The first of the icons `names` as a data URL, for a CSS mask that takes the text colour. */
function iconMask(names: string[]): string {
	const svg = getIcon(firstIcon(names));
	return svg ? `url("data:image/svg+xml,${encodeURIComponent(svg.outerHTML)}")` : "none";
}

/**
 * The explorer rows of the entry file `name` at the vault root and directly inside each repository's
 * model folder. The file name matches ignoring case; the folder must be named exactly like the repository.
 */
export function entryFileSelector(name: string, repos: string[]): string {
	const rows = [`.nav-file-title[data-path=${cssString(name)} i]`];
	for (const repo of repos) {
		// `i` applies to the whole path, so the prefix test keeps the folder name exact.
		rows.push(`.nav-file-title[data-path^=${cssString(`${repo}/`)}][data-path=${cssString(`${repo}/${name}`)} i]`);
	}
	return rows.join(", ");
}

/**
 * The model folders (REPO-2): the names of the git repositories in the project folder, worked out from it
 * each time and never stored (UI-42). None when no project folder is set or it has no repository (UI-41).
 */
export function modelFolders(projectFolder: string): string[] {
	return projectRepos(projectFolder).map((repo) => repo.name);
}

/**
 * The explorer rows of the model folders `repos`: a folder at the vault root named exactly like a repository,
 * matching case (UI-41). Null when there are none, since an empty selector list is invalid CSS.
 */
export function modelFolderSelector(repos: string[]): string | null {
	if (repos.length === 0) return null;
	// A folder's `data-path` is its path from the vault root, so a root folder's is just its name. HTML compares
	// `data-*` values case-sensitively, so `API` never matches `api`.
	return repos.map((repo) => `.nav-folder-title[data-path=${cssString(repo)}]`).join(", ");
}

/**
 * The stylesheet rule for an icon before `target`, masked from `mask` so it takes a colour, at the entry files'
 * size and spacing (UI-19). `declarations` are added to it.
 */
function iconRule(target: string, mask: string, declarations: string[]): string {
	return `${target}::before {
	content: "";
	flex: none;
	width: var(--icon-xs);
	height: var(--icon-xs);
	margin-right: var(--size-4-1);
${declarations.map((line) => `\t${line};\n`).join("")}	mask: ${mask} center / contain no-repeat;
	-webkit-mask: ${mask} center / contain no-repeat;
}`;
}

/**
 * Shows `index.md` and `instructions.md` in bold with an icon, at the vault root and directly inside a
 * model folder (a root folder named exactly like a repository in the project folder), and the history
 * icon left of each model folder's name (UI-40).
 *
 * It writes one stylesheet that targets the explorer rows by their `data-path`, the same attribute the
 * hidden-folder styles use, so it needs none of the explorer's internals and survives every re-render.
 * It is display only: it never writes to a file and never changes how the explorer sorts (UI-42).
 */
export class EntryFiles {
	private styleEl: HTMLStyleElement | null = null;

	constructor(private plugin: TheoryPlugin) {}

	/** Rewrites the stylesheet for the current model folders, read from the project folder now (UI-42). */
	sync() {
		const repos = modelFolders(this.plugin.settings.projectFolder);
		const rules = Object.keys(ENTRY_ICONS).map((name) => {
			const rows = entryFileSelector(name, repos);
			return `:is(${rows}) .nav-file-title-content { font-weight: var(--font-bold); }
${iconRule(`:is(${rows})`, iconMask(ENTRY_ICONS[name]), ["background-color: var(--text-muted)"])}`;
		});
		const folders = modelFolderSelector(repos);
		if (folders) {
			// UI-40: on the name itself, so it sits right of the collapse arrow, in the row's text colour. The name
			// keeps its normal weight.
			const target = `:is(${folders}) > .nav-folder-title-content`;
			const declarations = ["display: inline-block", "vertical-align: middle", "background-color: currentColor"];
			rules.push(iconRule(target, iconMask(MODEL_FOLDER_ICON), declarations));
		}
		const css = rules.join("\n");
		this.styleEl ??= document.head.createEl("style", { attr: { id: "theory-entry-files" } });
		if (this.styleEl.textContent !== css) this.styleEl.textContent = css;
	}

	detach() {
		this.styleEl?.remove();
		this.styleEl = null;
	}
}

// The explorer's items aren't in Obsidian's public types. Each has the row of its file or folder.
interface ExplorerFileItem {
	selfEl?: HTMLElement;
}
interface ExplorerWithItems extends View {
	fileItems?: Record<string, ExplorerFileItem>;
}

const DOT_CLASS = "theory-change-dot";

/**
 * A coloured dot right of each file and folder name in the file explorer: orange for uncommitted
 * changes, the accent colour for committed changes waiting for a compile (UI-24 to UI-27). Worked out
 * from git each time and never stored (UI-29). It only adds a small element to each row, so it never
 * writes to a file and never changes how the explorer sorts (UI-30).
 */
export class ChangeDots {
	private dots = new Map<string, ChangeDot>();
	// Ignores results from an older sync that finishes after a newer one.
	private syncId = 0;

	constructor(private plugin: TheoryPlugin) {}

	async sync() {
		const id = ++this.syncId;
		let dots = new Map<string, ChangeDot>();
		try {
			if (this.plugin.isVaultSetUp()) dots = changeDots(await readDotState(this.plugin.getVaultPath()));
		} catch {
			// Git couldn't be read; show no dots rather than wrong ones.
		}
		if (id !== this.syncId) return;
		this.dots = dots;
		this.render();
	}

	/** Puts the dots on every explorer's rows again, e.g. after the layout changes. */
	render() {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType("file-explorer")) {
			const items = (leaf.view as ExplorerWithItems).fileItems;
			if (!items) continue;
			for (const [path, item] of Object.entries(items)) {
				if (item.selfEl) this.renderRow(item.selfEl, this.dots.get(path));
			}
		}
	}

	private renderRow(row: HTMLElement, dot: ChangeDot | undefined) {
		let el = row.querySelector<HTMLElement>(`:scope > .${DOT_CLASS}`);
		if (!dot) {
			el?.remove();
			return;
		}
		el ??= row.createSpan({ cls: DOT_CLASS });
		el.toggleClass("is-uncommitted", isOrange(dot));
		el.toggleClass("is-pending", !isOrange(dot));
		el.setAttr("aria-label", DOT_TOOLTIPS[dot]);
	}

	detach() {
		this.syncId++;
		this.dots.clear();
		document.querySelectorAll(`.${DOT_CLASS}`).forEach((el) => el.remove());
	}
}
