import { describe, expect, it } from "vitest";
import { COMPILED_TAG } from "../src/compile";
import { DOT_TOOLTIPS, changeDots, isOrange, readDotState } from "../src/change-dots";
import { commitFiles, initRepo, out, tempFolder, write } from "./helpers";

describe("the change dots (UI-24 to UI-27)", () => {
	it("gives uncommitted and untracked files orange, committed and waiting files the accent colour, and compiled files none", () => {
		const dots = changeDots({
			uncommitted: ["Edited.md", "New.md"],
			tracked: ["Edited.md", "Waiting.md", "Compiled.md"],
			pending: ["Waiting.md"],
		});
		expect(dots.get("Edited.md")).toBe("uncommitted");
		expect(dots.get("New.md")).toBe("uncommitted");
		expect(dots.get("Waiting.md")).toBe("pending");
		expect(dots.has("Compiled.md")).toBe(false);
		expect(DOT_TOOLTIPS.uncommitted).toBe("Uncommitted changes");
		expect(DOT_TOOLTIPS.pending).toBe("Committed, waiting for a compile");
	});

	it("shows only orange for a file with both, with its own tooltip", () => {
		const dots = changeDots({ uncommitted: ["A.md"], tracked: ["A.md"], pending: ["A.md"] });
		expect(dots.get("A.md")).toBe("both");
		expect(isOrange("both")).toBe(true);
		expect(isOrange("pending")).toBe(false);
		expect(DOT_TOOLTIPS.both).toBe("Uncommitted changes. Earlier changes are waiting for a compile.");
	});

	it("marks every folder above a dotted file, at any depth, with orange winning", () => {
		const dots = changeDots({
			uncommitted: ["app/flows/deep/Login.md"],
			tracked: ["app/flows/deep/Login.md", "app/Compile.md", "other/x/Waiting.md"],
			pending: ["app/Compile.md", "other/x/Waiting.md"],
		});
		expect(dots.get("app/flows/deep")).toBe("uncommitted");
		expect(dots.get("app/flows")).toBe("uncommitted");
		expect(isOrange(dots.get("app")!)).toBe(true);
		expect(dots.get("other")).toBe("pending");
		expect(dots.get("other/x")).toBe("pending");
	});

	it("treats every tracked file as waiting when there is no compile marker", () => {
		const dots = changeDots({ uncommitted: [], tracked: ["A.md", "b/B.md"], pending: "all" });
		expect(dots.get("A.md")).toBe("pending");
		expect(dots.get("b")).toBe("pending");
	});

	it("never gives hidden notes, hidden folders or the root Instructions the accent colour, but still orange", () => {
		const tracked = ["_welcome.md", "app/_Scratch.md", "_templates/index.md", "Instructions.md", "app/instructions.md"];
		const dots = changeDots({ uncommitted: ["_templates/index.md"], tracked, pending: "all" });
		expect(dots.has("_welcome.md")).toBe(false);
		expect(dots.has("app/_Scratch.md")).toBe(false);
		expect(dots.has("Instructions.md")).toBe(false);
		expect(dots.get("_templates/index.md")).toBe("uncommitted");
		expect(dots.get("_templates")).toBe("uncommitted");
		// A model folder's instructions are sent to Claude, so they wait for a compile like any note.
		expect(dots.get("app/instructions.md")).toBe("pending");
		expect(dots.get("app")).toBe("pending");
	});

	it("never shows a dot for files in dot folders", () => {
		const dots = changeDots({ uncommitted: ["app/.comments/Compile.json"], tracked: [".comments/Index.json"], pending: "all" });
		expect(dots.size).toBe(0);
	});

	it("reads its state from git", async () => {
		const vault = tempFolder();
		await initRepo(vault, { "Compiled.md": "c\n", "Waiting.md": "w\n" });
		await out(vault, ["tag", COMPILED_TAG]);
		await commitFiles(vault, { "Waiting.md": "w2\n" }, "Update Waiting");
		write(vault, { "New.md": "n\n" });

		const dots = changeDots(await readDotState(vault));
		expect([...dots].sort()).toEqual([
			["New.md", "uncommitted"],
			["Waiting.md", "pending"],
		]);
	});
});
