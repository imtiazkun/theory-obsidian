import { mkdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { THEORY_COMMANDS, THEORY_RIBBON } from "../src/commands";
import { ribbonOrder } from "../src/first-load";
import { findProjectRepos } from "../src/project";
import { NO_PROJECT_FOLDER, NO_REPOSITORIES, SINGLE_REPOSITORY, newRepositoryProblem, projectFolderProblem } from "../src/repositories";
import { initRepo, tempFolder } from "./helpers";

describe("the commands (UI-10)", () => {
	it("are exactly the ones UI-10 lists, with New repository", () => {
		expect(THEORY_COMMANDS.map((command) => command.name)).toEqual([
			"Setup vault",
			"Show commit history",
			"Compile",
			"Build",
			"Show compile report",
			"Commit current note",
			"Show repositories",
			"Pull now",
			"Comment on selection",
			"Show comments",
			"Use theory.md's core plugins",
			"New repository",
		]);
		const ids = THEORY_COMMANDS.map((command) => command.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain("new-repository");
	});
});

describe("the ribbon (UI-8, CMP-1)", () => {
	it("has only the Repositories button, which opens the Repositories page", () => {
		expect(THEORY_RIBBON).toEqual([{ icon: "folder-git-2", title: "Show repositories", command: "show-repositories" }]);
		// No Compile button: the hammer is gone.
		const buttons: readonly { icon: string; command: string }[] = THEORY_RIBBON;
		expect(buttons.some((button) => button.icon === "hammer" || button.command === "compile")).toBe(false);
	});

	it("puts its one button last of theory.md's order (UI-43)", () => {
		const ids = [...THEORY_RIBBON.map((button) => `theory-md:${button.title}`), "graph:Open graph view"];
		expect(ribbonOrder(ids, "theory-md")).toEqual(["graph:Open graph view", "theory-md:Show repositories"]);
	});
});

describe("New repository (REPO-8, REPO-9, REPO-14, REPO-25)", () => {
	it("shows a notice instead of the form when no project folder is set", () => {
		expect(newRepositoryProblem("", findProjectRepos(""))).toBe(NO_PROJECT_FOLDER);
		expect(NO_PROJECT_FOLDER).toBe("Choose the project folder in theory.md settings first.");
	});

	it("shows the page's single repository text when the project folder is itself a repository", async () => {
		const folder = tempFolder();
		await initRepo(folder);
		expect(newRepositoryProblem(folder, findProjectRepos(folder))).toBe(
			"The project folder is a single repository. Choose a folder that holds repositories side by side to add more.",
		);
		expect(newRepositoryProblem(folder, findProjectRepos(folder))).toBe(SINGLE_REPOSITORY);
		// The page still shows its cards, with that text above them.
		expect(projectFolderProblem(folder, findProjectRepos(folder))).toBeNull();
	});

	it("shows the page's text when the project folder doesn't exist", () => {
		const folder = join(tempFolder(), "gone");
		expect(newRepositoryProblem(folder, findProjectRepos(folder))).toBe(`The project folder doesn't exist: ${folder}`);
	});

	it("opens the form for a folder that holds repositories side by side, or none yet", async () => {
		const empty = tempFolder();
		expect(newRepositoryProblem(empty, findProjectRepos(empty))).toBeNull();
		const folder = tempFolder();
		await initRepo(join(folder, "api"));
		mkdirSync(join(folder, "notes"));
		expect(newRepositoryProblem(folder, findProjectRepos(folder))).toBeNull();
	});

	it("points an empty Repositories page at the command", () => {
		expect(NO_REPOSITORIES).toBe("No repositories yet. Run New repository from the command palette to create one.");
	});
});
