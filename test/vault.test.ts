import { renameSync, rmSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { changedFiles, commit } from "../src/vault";
import { initRepo, out, tempFolder, write } from "./helpers";

/** Paths in the newest commit. */
async function committed(vault: string): Promise<string[]> {
	return (await out(vault, ["show", "--name-only", "--no-renames", "--format=", "HEAD"])).split("\n").filter(Boolean).sort();
}

async function vaultWith(files: Record<string, string>) {
	const vault = tempFolder();
	await initRepo(vault, files);
	return vault;
}

describe("changed files and commits", () => {
	it("a one-note commit commits only that note, signed by the author", async () => {
		const vault = await vaultWith({ "A.md": "a\n", "B.md": "b\n" });
		write(vault, { "A.md": "a2\n", "B.md": "b2\n", "New.md": "new\n" });
		// Something already staged must not slip in.
		await out(vault, ["add", "B.md"]);
		// Signed with the name and email git uses, the vault's own config first (CFG-34).
		await out(vault, ["config", "user.name", "Ada Engineer"]);
		await out(vault, ["config", "user.email", "ada@example.com"]);

		await commit(vault, "Update A", ["A.md"]);

		expect(await committed(vault)).toEqual(["A.md"]);
		expect(await out(vault, ["log", "-1", "--format=%an <%ae>|%s"])).toBe("Ada Engineer <ada@example.com>|Update A");
		expect((await changedFiles(vault)).sort()).toEqual(["B.md", "New.md"]);
	});

	it("an all-files commit commits every change, including new, deleted and renamed files", async () => {
		const vault = await vaultWith({ "A.md": "a\n", "Gone.md": "gone\n", "Old.md": "old\n" });
		write(vault, { "A.md": "a2\n", "folder/New.md": "new\n" });
		await out(vault, ["rm", "-q", "Gone.md"]);
		await out(vault, ["mv", "Old.md", "Renamed.md"]);

		expect((await changedFiles(vault)).sort()).toEqual(["A.md", "Gone.md", "Renamed.md", "folder/New.md"]);
		await commit(vault, "Update model", "all");

		expect(await committed(vault)).toEqual(["A.md", "Gone.md", "Old.md", "Renamed.md", "folder/New.md"]);
		expect(await changedFiles(vault)).toEqual([]);
	});

	it("an all-files commit takes a note Obsidian renamed or deleted on disk", async () => {
		const vault = await vaultWith({ "Old.md": "old\n", "Gone.md": "gone\n" });
		renameSync(join(vault, "Old.md"), join(vault, "Kept.md"));
		rmSync(join(vault, "Gone.md"));

		await commit(vault, "Update model", "all");

		expect(await committed(vault)).toEqual(["Gone.md", "Kept.md", "Old.md"]);
		expect(await changedFiles(vault)).toEqual([]);
	});

	it("leaves out `.obsidian/` when .gitignore ignores it", async () => {
		const vault = await vaultWith({ ".gitignore": ".obsidian/\n", "A.md": "a\n" });
		write(vault, { ".obsidian/app.json": "{}\n", "A.md": "a2\n" });

		expect(await changedFiles(vault)).toEqual(["A.md"]);
		await commit(vault, "Update model", "all");

		expect(await committed(vault)).toEqual(["A.md"]);
		expect(await changedFiles(vault)).toEqual([]);
	});

	it("leaves out `.obsidian/` in a vault that tracks it from before", async () => {
		const vault = await vaultWith({ ".obsidian/app.json": "{}\n", "A.md": "a\n" });
		write(vault, { ".obsidian/app.json": '{"changed":true}\n', ".obsidian/new.json": "{}\n", "A.md": "a2\n" });

		expect(await changedFiles(vault)).toEqual(["A.md"]);
		await commit(vault, "Update model", "all");

		expect(await committed(vault)).toEqual(["A.md"]);
		// Obsidian's config stays as it is, uncommitted.
		expect(await out(vault, ["status", "--porcelain", "--untracked-files=all"])).toBe(
			"M .obsidian/app.json\n?? .obsidian/new.json",
		);
	});
});
