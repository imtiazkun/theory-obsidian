import { TAbstractFile, TFile, TFolder, View, getIconIds, setIcon } from "obsidian";
import { projectRepos } from "./branches";
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
	fileItems?: Record<string, { selfEl?: HTMLElement }>;
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

/**
 * Shows `index.md` and `instructions.md` in bold with an icon, at the vault root and directly inside a
 * model folder (a root folder named exactly like a repository in the project folder). The bold is in styles.css.
 */
export class EntryFiles {
	private marked = new Set<HTMLElement>();

	constructor(private plugin: TheoryPlugin) {}

	private isEntry(file: TAbstractFile, modelFolders: Set<string>): boolean {
		if (!(file instanceof TFile) || !(file.name.toLowerCase() in ENTRY_ICONS)) return false;
		const parent = file.parent;
		if (!parent) return false;
		return parent.isRoot() || (parent.parent?.isRoot() === true && modelFolders.has(parent.name));
	}

	/** Marks every entry file in every file explorer, and unmarks files that stopped being one. */
	sync() {
		const modelFolders = new Set(projectRepos(this.plugin.settings.projectFolder).map((repo) => repo.name));
		const still = new Set<HTMLElement>();
		for (const leaf of this.plugin.app.workspace.getLeavesOfType("file-explorer")) {
			const items = (leaf.view as FileExplorerView).fileItems ?? {};
			for (const [path, item] of Object.entries(items)) {
				const el = item.selfEl;
				const file = this.plugin.app.vault.getAbstractFileByPath(path);
				if (!el || !file || !this.isEntry(file, modelFolders)) continue;
				still.add(el);
				if (this.marked.has(el) && el.querySelector(".theory-entry-icon")) continue;
				el.addClass("theory-entry-file");
				el.querySelector(".theory-entry-icon")?.remove();
				setIcon(el.createSpan({ cls: "theory-entry-icon", prepend: true }), entryIcon(file.name));
				this.marked.add(el);
			}
		}
		for (const el of [...this.marked]) if (!still.has(el)) this.unmark(el);
	}

	private unmark(el: HTMLElement) {
		el.removeClass("theory-entry-file");
		el.querySelector(".theory-entry-icon")?.remove();
		this.marked.delete(el);
	}

	detach() {
		for (const el of [...this.marked]) this.unmark(el);
	}
}
