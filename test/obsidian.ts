// A small stand-in for the `obsidian` module, which has no code outside the app. It holds only what the
// tested modules need when they load. Views, modals and the file explorer are checked by hand in Obsidian.

export class TAbstractFile {
	path = "";
	name = "";
}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}
export class View {}

export function getIconIds(): string[] {
	return ["lucide-house", "lucide-scroll"];
}

export function getIcon(): null {
	return null;
}
