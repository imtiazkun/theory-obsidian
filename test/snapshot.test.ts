import { readdirSync } from "fs";
import { join, relative } from "path";
import { describe, expect, it } from "vitest";
import { createSnapshot, removeSnapshot } from "../src/compile";
import { initRepo, out, tempFolder, write } from "./helpers";

/** Every file under `dir`, relative to it, sorted. */
function files(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(dir, join(entry.parentPath, entry.name)))
		.sort();
}

describe("the snapshot", () => {
	it("leaves out hidden folders, `.obsidian/` and the root Instructions, and only holds committed text", async () => {
		const vault = tempFolder();
		await initRepo(vault, {
			"Index.md": "index\n",
			"Instructions.md": "for humans\n",
			".obsidian/app.json": "{}\n",
			"_templates/Note.md": "template\n",
			"app/index.md": "app\n",
			"app/instructions.md": "for Claude\n",
			"app/_drafts/Draft.md": "draft\n",
			"app/Compile.md": "compile\n",
		});
		write(vault, { "Uncommitted.md": "not yet\n", "app/Compile.md": "edited\n" });

		const snapshot = await createSnapshot(vault, await out(vault, ["rev-parse", "HEAD"]));
		try {
			expect(files(snapshot)).toEqual(["Index.md", "app/Compile.md", "app/index.md", "app/instructions.md"]);
		} finally {
			await removeSnapshot(snapshot);
		}
	});
});
