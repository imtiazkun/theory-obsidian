import { join } from "path";
import { describe, expect, it } from "vitest";
import { trackedFiles } from "../src/code-snapshot";
import { readModelDiff } from "../src/model-diff";
import { HITS_IN_ALL, HITS_PER_RULE, NOT_FOUND, changedRules, compileScope, ruleMap, ruleMapText, scopeText, searchRules } from "../src/rule-map";
import { NOT_SENT } from "../src/compile";
import { commitFiles, initRepo, out, tempFolder, write } from "./helpers";

/** The changes between the vault's first commit and a commit of `files`. */
async function changesTo(before: Record<string, string>, after: Record<string, string>) {
	const vault = tempFolder();
	await initRepo(vault, before);
	const from = await out(vault, ["rev-parse", "HEAD"]);
	const to = await commitFiles(vault, after, "Change");
	return readModelDiff(vault, from, to, NOT_SENT);
}

const NOTE = `# Compile

**CMP-1.** The first rule.
It has a second line.

**CMP-2.** The second rule. See CMP-1 for more.

- **CMP-3.** A rule in a list.
- **CMP-4.** Another one.

A paragraph that names CMP-2 in passing.
`;

describe("the changed rules (CMP-92)", () => {
	it("lists a rule whose ID line changed", async () => {
		const changes = await changesTo({ "app/Compile.md": NOTE }, { "app/Compile.md": NOTE.replace("The second rule.", "The second rule, changed.") });
		expect(changedRules(changes.files)).toEqual([{ id: "CMP-2", path: "app/Compile.md" }]);
	});

	it("lists a rule whose paragraph changed, even when the ID's own line didn't", async () => {
		const changes = await changesTo({ "app/Compile.md": NOTE }, { "app/Compile.md": NOTE.replace("It has a second line.", "It has another line.") });
		expect(changedRules(changes.files)).toEqual([{ id: "CMP-1", path: "app/Compile.md" }]);
	});

	it("lists added and removed rules, and list items on their own", async () => {
		const after = NOTE.replace("- **CMP-4.** Another one.\n", "").replace("**CMP-2.**", "**CMP-5.** A new rule.\n\n**CMP-2.**");
		const changes = await changesTo({ "app/Compile.md": NOTE }, { "app/Compile.md": after });
		expect(changedRules(changes.files).map((r) => r.id).sort()).toEqual(["CMP-4", "CMP-5"]);
	});

	it("never counts an ID mentioned in passing, or a change outside every rule", async () => {
		const after = NOTE.replace("names CMP-2 in passing", "names CMP-2 and CMP-3 in passing").replace("# Compile", "# Compiling");
		const changes = await changesTo({ "app/Compile.md": NOTE }, { "app/Compile.md": after });
		expect(changedRules(changes.files)).toEqual([]);
	});

	it("lists every rule of a new note, and leaves out hidden notes and the root Instructions (INV-13, UI-22)", async () => {
		const changes = await changesTo(
			{ "Index.md": "# Index\n" },
			{ "app/New.md": "**NEW-1.** One.\n\n**NEW-2.** Two.\n", "_Hidden.md": "**HID-1.** Hidden.\n", "Instructions.md": "**INS-1.** For humans.\n" },
		);
		expect(changedRules(changes.files)).toEqual([
			{ id: "NEW-1", path: "app/New.md" },
			{ id: "NEW-2", path: "app/New.md" },
		]);
	});
});

describe("the rule search (CMP-93)", () => {
	it("finds each ID as a whole word in the files git tracks, as repo/path:line in code order", async () => {
		const code = tempFolder();
		write(code, {
			"api/src/a.ts": "// CMP-1 here\nconst x = 1; // CMP-10 is another rule\n",
			"api/src/b.ts": "x\ny\n// see CMP-1, and CMP-1 again\n",
			"api/untracked.ts": "// CMP-1\n",
			"web/main.ts": "XCMP-1 CMP-1x CMP-2\n",
			"web/image.png": "CMP-1\0binary",
		});
		const hits = await searchRules(["CMP-1", "CMP-2", "CMP-3"], code, [
			{ name: "api", files: ["src/a.ts", "src/b.ts"] },
			{ name: "web", files: ["main.ts", "image.png", "missing.ts"] },
		]);
		expect(hits.get("CMP-1")).toEqual(["api/src/a.ts:1", "api/src/b.ts:3"]);
		expect(hits.get("CMP-2")).toEqual(["web/main.ts:1"]);
		expect(hits.get("CMP-3")).toEqual([]);
	});

	it("reads the tracked files from git without changing the repository (CMP-85)", async () => {
		const repo = join(tempFolder(), "api");
		await initRepo(repo, { "src/a.ts": "a\n", "README.md": "r\n" });
		const head = await out(repo, ["rev-parse", "HEAD"]);
		write(repo, { "wip.ts": "wip\n" });
		expect(await trackedFiles(repo, head)).toEqual(["README.md", "src/a.ts"]);
		expect(await out(repo, ["status", "--porcelain"])).toBe("?? wip.ts");
	});
});

describe("the rule map (CMP-94, CMP-95)", () => {
	it("lists each changed rule with its hits, or Not found in the code", () => {
		const map = ruleMap(
			[
				{ id: "CMP-1", path: "app/Compile.md" },
				{ id: "CMP-2", path: "app/Compile.md" },
			],
			new Map([
				["CMP-1", ["app/src/a.ts:1", "app/src/b.ts:3"]],
				["CMP-2", []],
			]),
		);
		const text = ruleMapText(map);
		expect(text).toContain("- CMP-1 (app/Compile.md): app/src/a.ts:1, app/src/b.ts:3");
		expect(text).toContain(`- CMP-2 (app/Compile.md): ${NOT_FOUND}`);
		expect(NOT_FOUND).toBe("Not found in the code");
		expect(text).toContain("The map is a starting point, not the whole truth: a hit may be an unrelated mention, and code may follow a rule without citing its ID.");
		expect(text).toContain("Open the files in the map before you search on your own.");
	});

	it("keeps at most 20 hits per rule, in code order, and says how many more there are", () => {
		const hits = Array.from({ length: 25 }, (_, i) => `app/a.ts:${i + 1}`);
		const map = ruleMap([{ id: "CMP-1", path: "app/Compile.md" }], new Map([["CMP-1", hits]]));
		expect(HITS_PER_RULE).toBe(20);
		expect(map.rules[0].hits).toEqual(hits.slice(0, 20));
		expect(map.omitted).toBe(0);
		expect(ruleMapText(map)).toContain("app/a.ts:20 (and 5 more)");
	});

	it("holds at most 500 hits in all: each rule keeps its first hits, and the map says how many were left out", () => {
		expect(HITS_IN_ALL).toBe(500);
		const rules = Array.from({ length: 30 }, (_, i) => ({ id: `R-${i + 1}`, path: "Index.md" }));
		const hits = new Map(rules.map((r) => [r.id, Array.from({ length: 20 }, (_, i) => `app/${r.id}.ts:${i + 1}`)]));
		const map = ruleMap(rules, hits);
		expect(map.rules.reduce((sum, r) => sum + r.hits.length, 0)).toBe(500);
		// 30 rules share 500 hits: each keeps its first 16 or 17.
		expect(map.rules.every((r) => r.hits.length >= 16 && r.hits[0] === `app/${r.id}.ts:1`)).toBe(true);
		expect(map.omitted).toBe(100);
		expect(ruleMapText(map)).toContain("The map holds at most 500 hits, so 100 hits were left out.");
	});

	it("names a rule once, with every note it's in", () => {
		const map = ruleMap(
			[
				{ id: "CMP-1", path: "Index.md" },
				{ id: "CMP-1", path: "app/Compile.md" },
			],
			new Map([["CMP-1", []]]),
		);
		expect(ruleMapText(map)).toContain(`- CMP-1 (Index.md, app/Compile.md): ${NOT_FOUND}`);
	});
});

describe("the scope (CMP-96, CMP-97)", () => {
	const repos = ["api", "web", "cli"];

	it("holds each repository whose model folder holds a changed note", async () => {
		const changes = await changesTo({ "Index.md": "# Index\n" }, { "web/Page.md": "# Page\n\nWords.\n", "cli/image.png": "png" });
		expect(compileScope(repos, changes.files, changedRules(changes.files))).toEqual(["web"]);
	});

	it("is every repository when a changed rule sits in a note outside every model folder", async () => {
		const changes = await changesTo({ "Index.md": "# Index\n" }, { "Index.md": "# Index\n\n**INV-1.** A rule for all.\n" });
		expect(compileScope(repos, changes.files, changedRules(changes.files))).toEqual(repos);
	});

	it("isn't widened by other changes to such a note, or by hidden notes and the root Instructions", async () => {
		const changes = await changesTo(
			{ "Index.md": "# Index\n\nAn introduction.\n\n**INV-1.** A rule.\n" },
			{ "Index.md": "# Index\n\nA reworded introduction.\n\n**INV-1.** A rule.\n", "_Hidden.md": "**H-1.** x\n", "Instructions.md": "**I-1.** x\n" },
		);
		expect(compileScope(repos, changes.files, changedRules(changes.files))).toEqual([]);
	});

	it("also holds, in a recompile, each repository of an earlier issue that is still open", async () => {
		const changes = await changesTo({ "Index.md": "# Index\n" }, { "web/Page.md": "# Page\n" });
		expect(compileScope(repos, changes.files, changedRules(changes.files), [{ repo: "cli" }])).toEqual(["web", "cli"]);
	});

	it("tells Claude to plan only inside it, and to ask about work outside it", () => {
		const text = scopeText(["api"]);
		expect(text).toContain("This compile may plan issues only in these repositories: api.");
		expect(text).toContain("You may read code outside the scope to understand how the repositories connect, but plan issues only inside it.");
		expect(text).toContain("ask a question naming the notes that should say so");
		expect(scopeText([])).toContain("Plan no issues.");
	});
});
