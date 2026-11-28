import { symlinkSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { FIXED_CONTEXT_CHARS, PATHS_PER_REPO, fixedContextText, fixedParts } from "../src/fixed-context";
import { tempFolder, write } from "./helpers";

describe("the fixed context (CMP-106)", () => {
	it("holds the root Index.md, then each repository in the scope's AGENTS.md, CLAUDE.md and tracked paths", async () => {
		const model = tempFolder();
		const code = tempFolder();
		write(model, { "Index.md": "# Index\n\nThe system.\n" });
		write(code, { "api/AGENTS.md": "Run npm test.\n", "api/CLAUDE.md": "Use tabs.\n", "web/README.md": "web\n" });
		const parts = await fixedParts(model, code, [
			{ name: "api", files: ["AGENTS.md", "CLAUDE.md", "src/a.ts"] },
			{ name: "web", files: ["README.md"] },
		]);
		const text = fixedContextText(parts);
		expect(text.startsWith("These files are given here so you don't have to read them. Don't read them again.")).toBe(true);
		expect(text).toContain("### Index.md (in the model directory)\n\n# Index\n\nThe system.");
		expect(text).toContain("### api/AGENTS.md\n\nRun npm test.");
		expect(text).toContain("### api/CLAUDE.md\n\nUse tabs.");
		expect(text).toContain("### Files git tracks in api\n\nAGENTS.md\nCLAUDE.md\nsrc/a.ts");
		// web has neither file, so only its paths.
		expect(text).not.toContain("web/AGENTS.md");
		expect(text).toContain("### Files git tracks in web\n\nREADME.md");
		expect(text.indexOf("Index.md")).toBeLessThan(text.indexOf("api/AGENTS.md"));
	});

	it("sends a CLAUDE.md with the same text as AGENTS.md once, and never follows a link out of the snapshot", async () => {
		const model = tempFolder();
		const code = tempFolder();
		const outside = tempFolder();
		write(outside, { "secret.md": "secret\n" });
		write(code, { "api/AGENTS.md": "Run npm test.\n" });
		symlinkSync("AGENTS.md", join(code, "api", "CLAUDE.md"));
		write(code, { "web/.keep": "" });
		symlinkSync(join(outside, "secret.md"), join(code, "web", "AGENTS.md"));
		const text = fixedContextText(await fixedParts(model, code, [{ name: "api", files: [] }, { name: "web", files: [] }]));
		expect(text).toContain("### api/CLAUDE.md\n\nThe same text as api/AGENTS.md.");
		expect(text).not.toContain("secret");
	});

	it("lists at most 300 paths per repository, and says how many were left out", async () => {
		const files = Array.from({ length: 305 }, (_, i) => `src/f${i}.ts`);
		const text = fixedContextText(await fixedParts(tempFolder(), tempFolder(), [{ name: "api", files }]));
		expect(PATHS_PER_REPO).toBe(300);
		expect(text).toContain("src/f299.ts\n[5 more paths were left out.]");
		expect(text).not.toContain("src/f300.ts");
	});

	it("is cut at 60,000 characters in all, and names by path whatever is cut", () => {
		expect(FIXED_CONTEXT_CHARS).toBe(60_000);
		const parts = [
			{ title: "Index.md (in the model directory)", text: "i".repeat(100), where: "Index.md in the model directory" },
			{ title: "api/AGENTS.md", text: "a".repeat(200), where: "api/AGENTS.md in the code snapshot" },
			{ title: "api/CLAUDE.md", text: "c".repeat(50), where: "api/CLAUDE.md in the code snapshot" },
		];
		const text = fixedContextText(parts, 250);
		expect(text).toContain("i".repeat(100));
		expect(text).not.toContain("a".repeat(200));
		expect(text).toContain("[Cut here. Read the rest in api/AGENTS.md in the code snapshot.]");
		expect(text).not.toContain("c".repeat(50));
		expect(text).toContain("The fixed context is cut at 250 characters. Read these yourself if you need them: api/AGENTS.md in the code snapshot; api/CLAUDE.md in the code snapshot.");
	});
});
