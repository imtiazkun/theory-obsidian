import { renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
	initialTicks,
	keptTicks,
	parseHunks,
	pastCommit,
	ruleChanges,
	ruleChangesLabel,
	workingDiff,
} from "../src/commit-diff";
import { changedFiles, changes, commit, fileHistory } from "../src/vault";
import { commitFiles, initRepo, out, tempFolder, write } from "./helpers";

async function committed(vault: string): Promise<string[]> {
	return (await out(vault, ["show", "--name-only", "--no-renames", "--format=", "HEAD"])).split("\n").filter(Boolean).sort();
}

async function vaultWith(files: Record<string, string>) {
	const vault = tempFolder();
	await initRepo(vault, files);
	return vault;
}

async function diffOf(vault: string, path: string) {
	const change = (await changes(vault)).find((c) => c.path === path);
	if (!change) throw new Error(`${path} has no change`);
	return workingDiff(vault, change);
}

const lines = (text: string) => text.split("\n").map((_, i) => `line ${i + 1}`).join("\n");

describe("the Commit page's ticks (CMT-19, CMT-23)", () => {
	it("ticks only the note a commit started from", () => {
		expect(initialTicks(["A.md", "B.md"], "A.md")).toEqual(["A.md"]);
	});

	it("ticks every file when the floating bar started it with no note changed", () => {
		expect(initialTicks(["A.md", "B.md"], "all")).toEqual(["A.md", "B.md"]);
	});

	it("keeps ticks of files still changed, and leaves a newly changed file unticked", () => {
		expect(keptTicks(["A.md", "Gone.md"], ["A.md", "B.md", "New.md"])).toEqual(["A.md"]);
	});
});

describe("committing the ticked files (CMT-12)", () => {
	it("commits exactly the ticked files, nothing already staged slips in", async () => {
		const vault = await vaultWith({ "A.md": "a\n", "B.md": "b\n", "C.md": "c\n" });
		write(vault, { "A.md": "a2\n", "B.md": "b2\n", "C.md": "c2\n", "New.md": "new\n" });
		await out(vault, ["add", "C.md"]);

		await commit(vault, "Say why", ["A.md", "New.md"]);

		expect(await committed(vault)).toEqual(["A.md", "New.md"]);
		expect((await changedFiles(vault)).sort()).toEqual(["B.md", "C.md"]);
	});

	it("commits a ticked deletion, staged or not, and both sides of a staged rename", async () => {
		const vault = await vaultWith({ "Gone.md": "g\n", "Staged.md": "s\n", "Old.md": "old\n", "Keep.md": "k\n" });
		rmSync(join(vault, "Gone.md"));
		await out(vault, ["rm", "-q", "Staged.md"]);
		await out(vault, ["mv", "Old.md", "Renamed.md"]);
		write(vault, { "Keep.md": "k2\n" });

		await commit(vault, "Say why", ["Gone.md", "Staged.md", "Renamed.md"]);

		expect(await committed(vault)).toEqual(["Gone.md", "Old.md", "Renamed.md", "Staged.md"]);
		expect(await changedFiles(vault)).toEqual(["Keep.md"]);
	});
});

describe("the Commit page's diffs (CMT-20 to CMT-22)", () => {
	it("shows removed and added lines with 3 unchanged lines around, and folds the rest", async () => {
		const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
		const vault = await vaultWith({ "A.md": text });
		write(vault, { "A.md": text.replace("line 10\n", "line ten\n") });

		const diff = await diffOf(vault, "A.md");

		expect(diff.kind).toBe("modified");
		expect(diff.hunks).toHaveLength(1);
		expect(diff.hunks[0].foldedBefore).toBe(6);
		expect(diff.hunks[0].lines).toEqual([
			{ kind: "ctx", text: "line 7" },
			{ kind: "ctx", text: "line 8" },
			{ kind: "ctx", text: "line 9" },
			{ kind: "del", text: "line 10" },
			{ kind: "add", text: "line ten" },
			{ kind: "ctx", text: "line 11" },
			{ kind: "ctx", text: "line 12" },
			{ kind: "ctx", text: "line 13" },
		]);
	});

	it("folds the unchanged stretch between two hunks", () => {
		const hunks = parseHunks("@@ -1,4 +1,4 @@\n-a\n+b\n c\n d\n e\n@@ -20,4 +20,4 @@\n f\n g\n h\n-i\n+j\n");
		expect(hunks.map((h) => h.foldedBefore)).toEqual([0, 15]);
	});

	it("shows a new file all added and a deleted one all removed", async () => {
		const vault = await vaultWith({ "Gone.md": "one\ntwo\n" });
		rmSync(join(vault, "Gone.md"));
		write(vault, { "New.md": "first\nsecond\n" });

		const added = await diffOf(vault, "New.md");
		const removed = await diffOf(vault, "Gone.md");

		expect(added.kind).toBe("new");
		expect(added.hunks.flatMap((h) => h.lines)).toEqual([
			{ kind: "add", text: "first" },
			{ kind: "add", text: "second" },
		]);
		expect(removed.kind).toBe("deleted");
		expect(removed.hunks.flatMap((h) => h.lines)).toEqual([
			{ kind: "del", text: "one" },
			{ kind: "del", text: "two" },
		]);
	});

	it("names both paths of a rename", async () => {
		const vault = await vaultWith({ "Old.md": lines("x\n".repeat(5)) + "\n" });
		await out(vault, ["mv", "Old.md", "New.md"]);

		const diff = await diffOf(vault, "New.md");

		expect(diff).toMatchObject({ kind: "renamed", path: "New.md", oldPath: "Old.md" });
	});

	it("shows only the name and how it changed for a file that isn't text", async () => {
		const vault = await vaultWith({ "A.md": "a\n" });
		writeFileSync(join(vault, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 0, 3]));

		const diff = await diffOf(vault, "image.png");

		expect(diff).toMatchObject({ kind: "new", binary: true, hunks: [], rules: null });
	});

	it("lists the rules a note adds, changes and removes (CMT-21)", async () => {
		const vault = await vaultWith({ "A.md": "**CMT-1.** One.\n\n**CMT-2.** Two.\n\n**CMT-3.** Three.\n" });
		write(vault, { "A.md": "**CMT-1.** One.\n\n**CMT-2.** Two, changed.\n\n**CMT-16.** New.\n" });

		const diff = await diffOf(vault, "A.md");

		expect(diff.rules).toEqual({ added: ["CMT-16"], changed: ["CMT-2"], removed: ["CMT-3"] });
		expect(ruleChangesLabel(diff.rules!)).toBe("Adds CMT-16. Changes CMT-2. Removes CMT-3.");
	});

	it("never counts rules in code blocks, and says nothing when no rule changed", () => {
		const rules = ruleChanges("Text.\n", "Text.\n\n```\n**CMT-9.** Not a rule.\n```\n");
		expect(rules).toEqual({ added: [], changed: [], removed: [] });
		expect(ruleChangesLabel(rules)).toBe("");
	});
});

describe("a past commit on the Commit page (CMT-25 to CMT-27)", () => {
	it("shows the full message, author and every file, the clicked note first, diffed against the commit before", async () => {
		const vault = await vaultWith({ "A.md": "a\n", "B.md": "b\n" });
		write(vault, { "A.md": "a2\n", "B.md": "b2\n" });
		await out(vault, ["add", "-A"]);
		await out(vault, ["commit", "-q", "-m", "Change both\n\nBecause the rules moved."]);
		const hash = await out(vault, ["rev-parse", "HEAD"]);
		// Later changes never change the commit's diff.
		await commitFiles(vault, { "B.md": "b3\n" }, "Later");

		const past = await pastCommit(vault, hash, "B.md");

		expect(past.message).toBe("Change both\n\nBecause the rules moved.");
		expect(past.author).toBe("Test Author");
		expect(past.shortHash).toBe(hash.slice(0, past.shortHash.length));
		expect(past.files.map((f) => f.path)).toEqual(["B.md", "A.md"]);
		expect(past.files[0].hunks.flatMap((h) => h.lines)).toEqual([
			{ kind: "del", text: "b" },
			{ kind: "add", text: "b2" },
		]);
	});

	it("shows the first commit all added, and a rename with both paths", async () => {
		const vault = await vaultWith({ "Old.md": "one\ntwo\nthree\n" });
		const first = await out(vault, ["rev-parse", "HEAD"]);
		renameSync(join(vault, "Old.md"), join(vault, "New.md"));
		await out(vault, ["add", "-A"]);
		await out(vault, ["commit", "-q", "-m", "Rename"]);

		const root = await pastCommit(vault, first);
		const renamed = await pastCommit(vault, "HEAD");

		expect(root.files).toHaveLength(1);
		expect(root.files[0]).toMatchObject({ path: "Old.md", kind: "new" });
		expect(root.files[0].hunks.flatMap((h) => h.lines).every((l) => l.kind === "add")).toBe(true);
		expect(renamed.files).toEqual([expect.objectContaining({ path: "New.md", oldPath: "Old.md", kind: "renamed" })]);
	});

	it("history gives each commit the note's path at that commit, so a renamed note is found", async () => {
		const vault = await vaultWith({ "Old.md": "one\ntwo\nthree\n" });
		renameSync(join(vault, "Old.md"), join(vault, "New.md"));
		await out(vault, ["add", "-A"]);
		await out(vault, ["commit", "-q", "-m", "Rename"]);

		const history = await fileHistory(vault, "New.md");

		expect(history.map((c) => [c.subject, c.path])).toEqual([
			["Rename", "New.md"],
			["Initial commit", "Old.md"],
		]);
	});
});
