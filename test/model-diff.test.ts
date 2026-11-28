import { describe, expect, it } from "vitest";
import { DIFF_CUT, DIFF_SHORT_CONTEXT, diffText, limitedDiff, parseModelDiff, readModelDiff } from "../src/model-diff";
import { NOT_SENT, modelDiff } from "../src/compile";
import { git } from "../src/vault";
import { commitFiles, initRepo, out, tempFolder } from "./helpers";

const NOTE = [
	"# Compile",
	"",
	"Intro.",
	"",
	"## Rule map",
	"",
	"**CMP-92.** First.",
	"",
	"### Detail",
	"",
	"**CMP-93.** Second.",
	"",
	"## Scope",
	"",
	"**CMP-96.** Third.",
	"",
	"```bash",
	"# not a heading",
	"```",
	"",
	"**CMP-97.** Fourth.",
	"",
	"## Questions first",
	"",
	"**CMP-99.** Fifth.",
	"",
].join("\n");

async function vaultWith(before: Record<string, string>, after: Record<string, string>) {
	const vault = tempFolder();
	await initRepo(vault, before);
	const from = await out(vault, ["rev-parse", "HEAD"]);
	const to = await commitFiles(vault, after, "Change");
	return { vault, from, to };
}

describe("the diff with whole sections (CMP-10)", () => {
	it("shows a change with its section, from the heading above it to the next heading of the same or a higher level", async () => {
		const { vault, from, to } = await vaultWith({ "app/Compile.md": NOTE }, { "app/Compile.md": NOTE.replace("Fourth.", "Fourth, changed.") });
		const diff = await modelDiff(vault, from, to);
		expect(diff).toContain("app/Compile.md | 2 +-");
		// From "## Scope" to just before "## Questions first", with the fenced "# not a heading" inside.
		expect(diff).toContain(
			[
				"@@ -13,10 +13,10 @@",
				" ## Scope",
				" ",
				" **CMP-96.** Third.",
				" ",
				" ```bash",
				" # not a heading",
				" ```",
				" ",
				"-**CMP-97.** Fourth.",
				"+**CMP-97.** Fourth, changed.",
				" ",
			].join("\n"),
		);
		expect(diff).not.toContain("CMP-93");
		expect(diff).not.toContain("CMP-99");
	});

	it("takes in the lower headings of a section, but stops at a lower heading's end for a change under it", async () => {
		const { vault, from, to } = await vaultWith({ "app/Compile.md": NOTE }, { "app/Compile.md": NOTE.replace("First.", "First, changed.").replace("Second.", "Second, changed.") });
		const diff = await modelDiff(vault, from, to);
		expect(diff).toContain(" ## Rule map\n");
		expect(diff).toContain(" ### Detail\n");
		expect(diff).not.toContain("## Scope");
		expect(diff).not.toContain("Intro.");
	});

	it("shows a change above every heading with the lines up to the first heading", async () => {
		const { vault, from, to } = await vaultWith({ "Index.md": "Intro.\n\nMore.\n\n# Index\n\nBody.\n" }, { "Index.md": "Intro, changed.\n\nMore.\n\n# Index\n\nBody.\n" });
		const diff = await modelDiff(vault, from, to);
		expect(diff).toContain("@@ -1,4 +1,4 @@\n-Intro.\n+Intro, changed.\n \n More.\n \n");
		expect(diff).not.toContain("Body.");
	});

	it("keeps new, deleted and binary files, and three lines around a change in a file that isn't a note", async () => {
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
		const vault = tempFolder();
		await initRepo(vault, { "Old.md": "# Old\n", "data.txt": lines.join("\n") + "\n" });
		const from = await out(vault, ["rev-parse", "HEAD"]);
		await git(vault, ["rm", "-q", "Old.md"]);
		const to = await commitFiles(vault, { "New.md": "# New\n", "data.txt": lines.join("\n").replace("line 10", "line ten") + "\n", "image.png": "png\0bytes" }, "Change");
		const diff = await modelDiff(vault, from, to);
		expect(diff).toContain("+# New");
		expect(diff).toContain("deleted file mode 100644");
		expect(diff).toContain("-# Old");
		expect(diff).toContain("@@ -7,7 +7,7 @@\n line 7\n line 8\n line 9\n-line 10\n+line ten\n line 11\n line 12\n line 13\n");
		expect(diff).toContain("Binary files /dev/null and b/image.png differ");
	});

	it("reads paths with spaces and keeps git's note about a missing newline", () => {
		const changes = parseModelDiff(
			[
				" My Note.md | 2 +-",
				" 1 file changed, 1 insertion(+), 1 deletion(-)",
				"",
				"diff --git a/My Note.md b/My Note.md",
				"index 422c2b7..817f660 100644",
				"--- a/My Note.md\t",
				"+++ b/My Note.md\t",
				"@@ -1,2 +1,2 @@",
				" a",
				"-b",
				"+c",
				"\\ No newline at end of file",
				"",
			].join("\n"),
		);
		expect(changes.files[0].oldPath).toBe("My Note.md");
		expect(changes.files[0].newPath).toBe("My Note.md");
		expect(diffText(changes)).toContain("@@ -1,2 +1,2 @@\n a\n-b\n+c\n\\ No newline at end of file");
	});
});

describe("the diff limit (CMP-11)", () => {
	it("falls back to three lines around each change when whole sections are too long, then cuts that", async () => {
		const body = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}.`).join("\n");
		const { vault, from, to } = await vaultWith({ "Note.md": `# Note\n\n${body}\n` }, { "Note.md": `# Note\n\n${body.replace("Line 20.", "Line twenty.")}\n` });
		const changes = await readModelDiff(vault, from, to, NOT_SENT);
		const sections = diffText(changes);
		expect(limitedDiff(changes, sections.length)).toBe(sections);

		const short = limitedDiff(changes, sections.length - 1);
		expect(short.startsWith(DIFF_SHORT_CONTEXT)).toBe(true);
		expect(short).toContain("@@ -19,7 +19,7 @@\n Line 17.\n Line 18.\n Line 19.\n-Line 20.\n+Line twenty.\n Line 21.\n");
		expect(short).not.toContain("Line 16.");

		const cut = limitedDiff(changes, 100);
		expect(cut).toBe(short.slice(0, 100) + DIFF_CUT);
	});
});
