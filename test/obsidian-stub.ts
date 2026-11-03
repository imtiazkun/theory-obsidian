// The small part of Obsidian's API that the tested modules import. Views, modals and the file
// explorer aren't tested automatically; a person checks them in Obsidian (TEST-7).

export class TAbstractFile {
	path = "";
	name = "";
	parent: TFolder | null = null;
}
export class TFile extends TAbstractFile {
	basename = "";
	extension = "";
}
export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot(): boolean {
		return this.parent === null;
	}
}
export class Notice {
	constructor(public message?: string) {}
}
export class View {}
export class ItemView extends View {}
export class Modal {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class MarkdownView extends View {}
export class FileSystemAdapter {}

export function setIcon(): void {}
export function setTooltip(): void {}
export function getIcon(): null {
	return null;
}
export function getIconIds(): string[] {
	return [];
}
export function debounce<T extends (...args: never[]) => unknown>(fn: T): T {
	return fn;
}
