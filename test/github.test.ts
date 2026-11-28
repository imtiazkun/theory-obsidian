import { chmodSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { existingPullRequest, ghGitHub, parseJsonList } from "../src/github";
import { commitFiles, initRepo, out, tempFolder } from "./helpers";

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

describe("a pull request already on GitHub (REP-58)", () => {
	/** A repository with `branch`, and a fake gh whose `pr list` prints one pull request from its head. */
	async function repoWithPullRequest(state: string) {
		const repo = tempFolder();
		await initRepo(repo);
		await out(repo, ["switch", "-c", "theory/epic-41-signup"]);
		const head = await commitFiles(repo, { "a.txt": "a\n" }, "Add a");
		const bin = tempFolder();
		const listed = JSON.stringify([{ url: "https://github.com/o/r/pull/498", state, isDraft: false, headRefOid: head }]);
		writeFileSync(join(bin, "gh"), `#!/bin/sh\nif [ "$1 $2" = "pr list" ]; then printf '%s' '${listed}'; fi\nexit 0\n`);
		chmodSync(join(bin, "gh"), 0o755);
		process.env.PATH = `${bin}:${originalPath}`;
		return repo;
	}

	it("is found when it was merged", async () => {
		const repo = await repoWithPullRequest("MERGED");
		expect(await existingPullRequest(repo, "theory/epic-41-signup")).toEqual({ url: "https://github.com/o/r/pull/498", state: "merged" });
	});

	it("is found when it is open", async () => {
		const repo = await repoWithPullRequest("OPEN");
		expect((await existingPullRequest(repo, "theory/epic-41-signup"))?.state).toBe("open");
	});

	it("doesn't count when it was closed, so a new one can replace it", async () => {
		const repo = await repoWithPullRequest("CLOSED");
		expect(await existingPullRequest(repo, "theory/epic-41-signup")).toBeNull();
	});
});
