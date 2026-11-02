import { TAbstractFile, TFolder, View } from "obsidian";
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
