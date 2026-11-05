import { join } from "path";
import { describe, expect, it } from "vitest";
import { NOT_COMMITTED, formatAuthorDate, noteRuleAuthors } from "../src/rule-authors";
import { findRules } from "../src/rule-count";
import { git } from "../src/vault";
import { initRepo, tempFolder, write } from "./helpers";

/** Commits `files` as `name`, at `date` (ISO, with its offset). */
async function commitAs(repo: string, files: Record<string, string>, message: string, name: string, date: string) {
	write(repo, files);
	await git(repo, ["add", "-A"]);
	await git(repo, ["-c", `user.name=${name}`, "-c", `user.email=${name.toLowerCase()}@example.com`, "commit", "-m", message], {
		GIT_AUTHOR_DATE: date,
		GIT_COMMITTER_DATE: date,
	});
}

const NOTE = [
	"Intro, not a rule.",
	"",
	"**PULL-1.** The first rule,",
	"on two lines.",
	"",
	"- **PULL-2.** A list item.",
	"- **PULL-3.** Another one.",
	"",
	"## Heading",
	"**PULL-4.** Under a heading.",
	"",
].join("\n");

describe("rule spans (HDR-15)", () => {
	it("ends a rule where its paragraph or list item ends", () => {
		expect(findRules(NOTE).map((r) => [`${r.prefix}-${r.number}`, r.line, r.endLine])).toEqual([
			["PULL-1", 2, 3],
			["PULL-2", 5, 5],
			["PULL-3", 6, 6],
			["PULL-4", 9, 9],
		]);
	});

	it("counts lines from the top of the note, front matter included", () => {
		const text = ["---", "realized: false", "---", "**CMT-1.** A rule.", "Its second line."].join("\n");
		expect(findRules(text).map((r) => [r.line, r.endLine])).toEqual([[3, 4]]);
	});
});

describe("rule authors (HDR-14 to HDR-18)", () => {
	async function vault() {
		const path = join(tempFolder(), "vault");
		await initRepo(path, { "README.md": "readme\n" });
		await commitAs(path, { "Pull.md": NOTE }, "Describe pulls", "Ana", "2026-11-01T09:05:00+00:00");
		return path;
	}

	it("names the author and local author date of the newest commit that changed any line of the rule", async () => {
		const path = await vault();
		// Bea fixes only the last line of PULL-1.
		const edited = NOTE.replace("on two lines.", "on two lines, fixed.");
		await commitAs(path, { "Pull.md": edited }, "Fix the first rule", "Bea", "2026-11-03T17:20:00+00:00");

		const authors = await noteRuleAuthors(path, "Pull.md", edited);

		const bea = `Bea · ${formatAuthorDate(Date.parse("2026-11-03T17:20:00Z"))}`;
		const ana = `Ana · ${formatAuthorDate(Date.parse("2026-11-01T09:05:00Z"))}`;
		expect(authors.map((a) => [a.line, a.label])).toEqual([
			[2, bea],
			[5, ana],
			[6, ana],
			[9, ana],
		]);
		const hash = (await git(path, ["rev-parse", "--short=7", "HEAD"])).stdout.trim();
		expect(authors[0].tooltip).toBe(`Fix the first rule (${hash})`);
	});

	it("shows Not committed yet for a rule with any uncommitted line, unsaved edits included", async () => {
		const path = await vault();
		const typed = NOTE.replace("A list item.", "A list item, edited.");

		const authors = await noteRuleAuthors(path, "Pull.md", typed);

		expect(authors.map((a) => a.label === NOT_COMMITTED)).toEqual([false, true, false, false]);
		expect(authors[1].tooltip).toBe("");
	});

	it("shows Not committed yet for every rule of a note git doesn't track", async () => {
		const path = await vault();
		write(path, { "New.md": NOTE });

		const authors = await noteRuleAuthors(path, "New.md", NOTE);

		expect(authors.map((a) => a.label)).toEqual([NOT_COMMITTED, NOT_COMMITTED, NOT_COMMITTED, NOT_COMMITTED]);
	});

	it("never writes the labels into the note", async () => {
		const path = await vault();
		await noteRuleAuthors(path, "Pull.md", NOTE);
		expect((await git(path, ["status", "--porcelain"])).stdout).toBe("");
	});

	it("formats the date as YYYY-MM-DD HH:mm in local time", () => {
		expect(formatAuthorDate(new Date(2026, 10, 3, 7, 5).getTime())).toBe("2026-11-03 07:05");
	});
});
