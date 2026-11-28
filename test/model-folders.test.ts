// @vitest-environment jsdom
import { mkdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { modelFolderSelector, modelFolders } from "../src/explorer";
import { initRepo, tempFolder } from "./helpers";

/** Whether the explorer folder row for `path` shows the model folder icon, with the repositories `repos`. */
function hasIcon(path: string, repos: string[], row = "nav-folder-title"): boolean {
	const selector = modelFolderSelector(repos);
	if (selector === null) return false;
	const el = document.createElement("div");
	el.className = row;
	el.setAttribute("data-path", path);
	return el.matches(selector);
}

/** A project folder holding the git repositories `api` and `web-app`, and a plain folder `notes`. */
async function project(): Promise<string> {
	const folder = tempFolder();
	await initRepo(join(folder, "api"));
	await initRepo(join(folder, "web-app"));
	mkdirSync(join(folder, "notes"));
	return folder;
}

describe("the model folder icon", () => {
	it("counts only the git repositories in the project folder (UI-41)", async () => {
		expect(modelFolders(await project())).toEqual(["api", "web-app"]);
	});

	it("shows on the root folders named exactly like a repository (UI-40, UI-41)", async () => {
		const repos = modelFolders(await project());
		expect(hasIcon("api", repos)).toBe(true);
		expect(hasIcon("web-app", repos)).toBe(true);
	});

	it("shows on no other folder: other case, below the root, not a repository, or a file (UI-41)", async () => {
		const repos = modelFolders(await project());
		for (const path of ["API", "Api", "Web-App", "notes", "other", "apis", "xapi", "api-old", "web", "docs/api", "api/api", "api/sub", "_templates"]) {
			expect(hasIcon(path, repos), path).toBe(false);
		}
		expect(hasIcon("api", repos, "nav-file-title")).toBe(false);
	});

	it("shows on no folder without a project folder, or with one holding no repository (UI-41)", async () => {
		expect(modelFolders("")).toEqual([]);
		expect(modelFolderSelector([])).toBeNull();
		expect(hasIcon("api", modelFolders(""))).toBe(false);
		expect(modelFolders(join(tempFolder(), "missing"))).toEqual([]);
		const empty = tempFolder();
		mkdirSync(join(empty, "api"));
		expect(hasIcon("api", modelFolders(empty))).toBe(false);
	});

	it("follows the project folder each time it is read (UI-42)", async () => {
		const folder = await project();
		expect(hasIcon("cli", modelFolders(folder))).toBe(false);
		await initRepo(join(folder, "cli"));
		expect(hasIcon("cli", modelFolders(folder))).toBe(true);
	});

	it("keeps quotes in a repository name inside the selector", () => {
		expect(hasIcon('we"ird', ['we"ird'])).toBe(true);
		expect(hasIcon("we", ['we"ird'])).toBe(false);
	});
});
