import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createSnapshot, removeSnapshot } from "../src/compile";
import { repo, tempDir } from "./helpers";

function files(dir: string): string[] {
	return execFileSync("find", [".", "-type", "f"], { cwd: dir, encoding: "utf8" })
		.split("\n")
		.filter(Boolean)
		.map((path) => path.replace(/^\.\//, ""))
		.sort();
}

describe("the snapshot", () => {
	it("leaves out hidden folders, .obsidian/ and the root Instructions", async () => {
		// An older vault that still tracks .obsidian/.
		const vault = repo(tempDir(), {
			"Index.md": "Index\n",
			"Instructions.md": "Human only\n",
			"app/index.md": "App\n",
			"app/instructions.md": "Rules for Claude\n",
			"app/_drafts/Idea.md": "Hidden\n",
			"_templates/index.md": "Template\n",
			".obsidian/app.json": "{}\n",
		});
		const snapshot = await createSnapshot(vault, "HEAD");
		try {
			expect(files(snapshot)).toEqual(["Index.md", "app/index.md", "app/instructions.md"]);
		} finally {
			await removeSnapshot(snapshot);
		}
	});

	it("leaves out the root Instructions under any of its names", async () => {
		const vault = repo(tempDir(), { "Index.md": "Index\n", "instruction.md": "Human only\n" });
		const snapshot = await createSnapshot(vault, "HEAD");
		try {
			expect(files(snapshot)).toEqual(["Index.md"]);
		} finally {
			await removeSnapshot(snapshot);
		}
	});
});
