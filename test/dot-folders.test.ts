import { readdirSync } from "fs";
import { join, relative } from "path";
import { describe, expect, it } from "vitest";
import { COMPILED_TAG, createSnapshot, modelDiff, pendingRevisionCount, removeSnapshot, revisionsBetween, workingTreeState } from "../src/compile";
import { changedFiles, isInDotFolder } from "../src/vault";
import { commitFiles, initRepo, out, tempFolder, write } from "./helpers";

function files(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(dir, join(entry.parentPath, entry.name)))
		.sort();
}

const COMMENTS = {
	".comments/Index.json": "{}\n",
	"app/.comments/Compile.json": "{}\n",
	"app/.comments/flows/Login.json": "{}\n",
};

describe("dot folders", () => {
	it("knows which paths are in a dot folder, at any depth", () => {
		expect(isInDotFolder(".comments/Index.json")).toBe(true);
		expect(isInDotFolder("app/.comments/flows/Login.json")).toBe(true);
		expect(isInDotFolder(".obsidian/app.json")).toBe(true);
		expect(isInDotFolder(".gitignore")).toBe(false);
		expect(isInDotFolder("app/Compile.md")).toBe(false);
		expect(isInDotFolder("app/.hidden.md")).toBe(false);
	});

	it("are left out of the snapshot and the compile diff (INV-13)", async () => {
		const vault = tempFolder();
		await initRepo(vault, { "Index.md": "index\n", "app/Compile.md": "compile\n", ...COMMENTS });
		const head = await out(vault, ["rev-parse", "HEAD"]);

		const snapshot = await createSnapshot(vault, head);
		try {
			expect(files(snapshot)).toEqual(["Index.md", "app/Compile.md"]);
		} finally {
			await removeSnapshot(snapshot);
		}
		const diff = await modelDiff(vault, null, head);
		expect(diff).toContain("app/Compile.md");
		expect(diff).not.toContain(".comments");
	});

	it("are left out of the vault check, so a comment during a compile isn't a change (INV-6)", async () => {
		const vault = tempFolder();
		await initRepo(vault, { "Index.md": "index\n" });
		write(vault, { "app/.comments/Compile.json": "{}\n", "Index.md": "edited\n" });

		expect([...(await workingTreeState(vault)).keys()]).toEqual(["Index.md"]);
		expect(await changedFiles(vault)).toEqual(["Index.md"]);
	});

	it("a revision that only changes them is never pending", async () => {
		const vault = tempFolder();
		await initRepo(vault, { "Index.md": "index\n" });
		await out(vault, ["tag", COMPILED_TAG]);
		await commitFiles(vault, { "app/.comments/Compile.json": "{}\n" }, "Comment on Compile");
		await commitFiles(vault, { ".comments/Index.json": "{}\n" }, "Comment on Index");
		expect(await pendingRevisionCount(vault)).toBe(0);

		const head = await commitFiles(vault, { "app/Compile.md": "compile\n" }, "Add Compile");
		expect(await pendingRevisionCount(vault)).toBe(1);
		const from = await out(vault, ["rev-parse", COMPILED_TAG]);
		expect((await revisionsBetween(vault, from, head)).map((r) => r.subject)).toEqual(["Add Compile"]);
	});
});
