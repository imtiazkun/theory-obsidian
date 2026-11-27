import { chmodSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { ghGitHub, parseJsonList } from "../src/github";
import { tempFolder } from "./helpers";

const originalPath = process.env.PATH;
afterEach(() => {
	process.env.PATH = originalPath;
});

/**
 * Puts a fake `gh` first on PATH. It logs every call's arguments, one call per line, and prints `labels` for
 * `gh label list`: like the real gh, it prints nothing at all when `labels` is empty.
 */
function fakeGh(labels: string[]) {
	const bin = tempFolder();
	const log = join(bin, "calls.log");
	const listed = labels.length ? JSON.stringify(labels.map((name) => ({ name }))) : "";
	writeFileSync(
		join(bin, "gh"),
		`#!/bin/sh\necho "$*" >> "${log}"\nif [ "$1 $2" = "label list" ]; then printf '%s' '${listed}'; fi\nexit 0\n`,
	);
	chmodSync(join(bin, "gh"), 0o755);
	process.env.PATH = `${bin}:${originalPath}`;
	return () => readFileSync(log, "utf8").trim().split("\n");
}

describe("lists gh prints with --json", () => {
	it("reads empty output as an empty list", () => {
		expect(parseJsonList("")).toEqual([]);
		expect(parseJsonList("  \n")).toEqual([]);
		expect(parseJsonList('[{"name":"epic"}]')).toEqual([{ name: "epic" }]);
	});
});

describe("the epic label (CMP-65)", () => {
	it("is created when gh's label search finds nothing and prints nothing", async () => {
		const calls = fakeGh([]);
		await ghGitHub.ensureLabel(tempFolder(), "epic");
		expect(calls()[1]).toBe("label create epic --description A theory.md compile's epic");
	});

	it("isn't created again when the repository has it", async () => {
		const calls = fakeGh(["Epic"]);
		await ghGitHub.ensureLabel(tempFolder(), "epic");
		expect(calls()).toEqual(["label list --search epic --json name --limit 100"]);
	});
});

/** Puts a fake `gh` first on PATH that prints `stderr` and exits with 1, like a refused GraphQL call. */
function failingGh(stderr: string) {
	const bin = tempFolder();
	writeFileSync(join(bin, "gh"), `#!/bin/sh\necho '${stderr}' >&2\nexit 1\n`);
	chmodSync(join(bin, "gh"), 0o755);
	process.env.PATH = `${bin}:${originalPath}`;
}

describe("adding an issue to the GitHub Project (CMP-66)", () => {
	const project = "https://github.com/users/ana/projects/6";
	const issue = "https://github.com/ana/app/issues/40";

	it("counts an issue the project already has as added", async () => {
		// A project's "Auto-add sub-issues" workflow adds a sub-issue as soon as it's linked to its epic.
		failingGh("GraphQL: Content already exists in this project (addProjectV2ItemById)");
		await expect(ghGitHub.addToProject(project, issue, tempFolder())).resolves.toBeUndefined();
	});

	it("still fails for any other reason", async () => {
		failingGh("GraphQL: Resource not accessible by integration (addProjectV2ItemById)");
		await expect(ghGitHub.addToProject(project, issue, tempFolder())).rejects.toThrow("Resource not accessible");
	});
});
