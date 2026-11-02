// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { entryFileSelector } from "../src/explorer";

/** Whether the explorer row for `path` matches the highlight of entry file `name`. */
function highlighted(name: string, path: string, repos = ["api", "web-app"]): boolean {
	const row = document.createElement("div");
	row.className = "nav-file-title";
	row.setAttribute("data-path", path);
	return row.matches(entryFileSelector(name, repos));
}

describe("the index and instructions highlight", () => {
	it("matches the entry files at the vault root and directly inside a model folder, ignoring the file name's case", () => {
		for (const path of ["index.md", "Index.md", "INDEX.MD", "api/index.md", "api/Index.md", "web-app/index.md"]) {
			expect(highlighted("index.md", path), path).toBe(true);
		}
		for (const path of ["Instructions.md", "instructions.md", "api/instructions.md", "web-app/INSTRUCTIONS.md"]) {
			expect(highlighted("instructions.md", path), path).toBe(true);
		}
	});

	it("matches no other path", () => {
		for (const path of [
			"other/index.md",
			"API/index.md",
			"Api/index.md",
			"api/sub/index.md",
			"api/index.md.bak",
			"xapi/index.md",
			"api-old/index.md",
			"web/index.md",
			"_templates/index.md",
			"myindex.md",
			"index.markdown",
			"api/instructions.md",
		]) {
			expect(highlighted("index.md", path), path).toBe(false);
		}
		expect(highlighted("instructions.md", "api/index.md")).toBe(false);
		expect(highlighted("instructions.md", "instruction.md")).toBe(false);
	});

	it("matches only the vault root without repositories", () => {
		expect(highlighted("index.md", "index.md", [])).toBe(true);
		expect(highlighted("index.md", "api/index.md", [])).toBe(false);
	});

	it("keeps quotes in a repository name inside the selector", () => {
		expect(highlighted("index.md", 'we"ird/index.md', ['we"ird'])).toBe(true);
	});
});
