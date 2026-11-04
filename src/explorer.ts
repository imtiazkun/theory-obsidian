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

/** The first icon this Obsidian version has, since Lucide renames icons between versions. */
function entryIcon(name: string): string {
	const names = ENTRY_ICONS[name.toLowerCase()];
	const ids = getIconIds();
	return names.find((icon) => ids.includes(`lucide-${icon}`)) ?? names[names.length - 1];
}

/** A quoted CSS string, for an attribute selector. */
function cssString(value: string): string {
	return `"${value.replace(/["\\]/g, "\\$&").replace(/\n/g, "\\a ")}"`;
}

/** The icon as a data URL, for a CSS mask that takes the text colour. */
function iconMask(name: string): string {
	const svg = getIcon(entryIcon(name));
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
 * Shows `index.md` and `instructions.md` in bold with an icon, at the vault root and directly inside a
 * model folder (a root folder named exactly like a repository in the project folder).
 *
 * It writes one stylesheet that targets the explorer rows by their `data-path`, the same attribute the
 * hidden-folder styles use, so it needs none of the explorer's internals and survives every re-render.
 */
export class EntryFiles {
	private styleEl: HTMLStyleElement | null = null;

	constructor(private plugin: TheoryPlugin) {}

	/** Rewrites the stylesheet for the current model folders. */
	sync() {
		const repos = projectRepos(this.plugin.settings.projectFolder).map((repo) => repo.name);
		const rules = Object.keys(ENTRY_ICONS).map((name) => {
			const rows = entryFileSelector(name, repos);
			return `:is(${rows}) .nav-file-title-content { font-weight: var(--font-bold); }
:is(${rows})::before {
	content: "";
	flex: none;
	width: var(--icon-xs);
	height: var(--icon-xs);
	margin-right: var(--size-4-1);
	background-color: var(--text-muted);
	mask: ${iconMask(name)} center / contain no-repeat;
	-webkit-mask: ${iconMask(name)} center / contain no-repeat;
}`;
		});
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
