// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { entryFileSelector } from "../src/explorer";

function matches(name: string, path: string, folders = ["app", "api"]): boolean {
	const row = document.createElement("div");
	row.className = "nav-file-title";
	row.dataset.path = path;
	return row.matches(entryFileSelector(name, folders));
}

describe("the index and instructions highlight", () => {
	it("matches index.md and instructions.md at the root and directly in a model folder, ignoring the file's case", () => {
		expect(matches("index.md", "Index.md")).toBe(true);
		expect(matches("index.md", "app/index.md")).toBe(true);
		expect(matches("index.md", "api/INDEX.md")).toBe(true);
		expect(matches("instructions.md", "Instructions.md")).toBe(true);
		expect(matches("instructions.md", "app/instructions.md")).toBe(true);
	});

	it("matches nothing else", () => {
		expect(matches("index.md", "notes/index.md")).toBe(false);
		expect(matches("index.md", "app/sub/index.md")).toBe(false);
		expect(matches("index.md", "App/index.md")).toBe(false);
		expect(matches("index.md", "app/index.md.bak")).toBe(false);
		expect(matches("index.md", "app/My index.md")).toBe(false);
		expect(matches("index.md", "app/instructions.md")).toBe(false);
		expect(matches("instructions.md", "instruction.md")).toBe(false);
		expect(matches("instructions.md", "_templates/instructions.md")).toBe(false);
		expect(matches("index.md", "app/index.md", [])).toBe(false);
	});
});
