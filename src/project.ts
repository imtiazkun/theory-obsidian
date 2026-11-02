import { existsSync, readdirSync, statSync } from "fs";
import { basename, join } from "path";

export type ProjectRepos =
	| { kind: "missing" }
	/** The project folder is itself a git repository. */
	| { kind: "root"; repos: string[] }
	/** Git repositories found one level down. */
	| { kind: "children"; repos: string[] }
	| { kind: "none" };

function isRepo(path: string): boolean {
	return existsSync(join(path, ".git"));
}

/** Finds the git repositories in the project folder: the folder itself, or its immediate children. */
export function findProjectRepos(folder: string): ProjectRepos {
	if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) return { kind: "missing" };
	if (isRepo(folder)) return { kind: "root", repos: [folder] };

	const repos = readdirSync(folder, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.map((entry) => join(folder, entry.name))
		.filter(isRepo)
		.sort((a, b) => basename(a).localeCompare(basename(b)));
	return repos.length > 0 ? { kind: "children", repos } : { kind: "none" };
}

interface ElectronDialog {
	showOpenDialog(options: {
		title: string;
		defaultPath?: string;
		buttonLabel?: string;
		properties: string[];
	}): Promise<{ canceled: boolean; filePaths: string[] }>;
}

/** Opens the system folder picker. Returns null when cancelled or unavailable. */
export async function pickFolder(defaultPath?: string): Promise<string | null> {
	// Obsidian's desktop app exposes Electron's remote module as a global.
	const dialog = (window as unknown as { electron?: { remote?: { dialog?: ElectronDialog } } }).electron?.remote
		?.dialog;
	if (!dialog) throw new Error("The folder picker is only available in the desktop app.");
	const result = await dialog.showOpenDialog({
		title: "Choose the project folder",
		defaultPath: defaultPath || undefined,
		buttonLabel: "Choose",
		properties: ["openDirectory", "createDirectory", "dontAddToRecent"],
	});
	return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
}
