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
