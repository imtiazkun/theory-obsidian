import { join } from "path";
import { describe, expect, it } from "vitest";
import { NOT_SENT } from "../src/compile";
import { uncommittedDiff } from "../src/vault";
import { initRepo, tempFolder, write } from "./helpers";

// The commit message sparkle (CMT-7) reads this diff. Some git versions (2.54, Apple Git-157) list
// nothing when file paths and exclude pathspecs are given together and a folder name is 7 or more
// characters long, so a note in `obsidian-plugin/` used to look like it held no changes at all.
describe("uncommittedDiff", () => {
	async function vault() {
		const dir = join(tempFolder(), "vault");
		await initRepo(dir, {
			"Index.md": "index\n",
			"Instructions.md": "human only\n",
			"obsidian-plugin/Hooks.md": "hooks\n",
			"obsidian-plugin/_draft.md": "hidden\n",
			"obsidian-plugin/.comments/Hooks.json": "{}\n",
		});
		return dir;
	}

	it("includes a changed note in a folder with a long name", async () => {
		const dir = await vault();
		write(dir, { "obsidian-plugin/Hooks.md": "hooks\nHOOK-1.\n" });

		const diff = await uncommittedDiff(dir, ["obsidian-plugin/Hooks.md"], NOT_SENT);

		expect(diff).toContain("obsidian-plugin/Hooks.md");
		expect(diff).toContain("+HOOK-1.");
	});

	it("includes a new note in a folder with a long name", async () => {
		const dir = await vault();
		write(dir, { "obsidian-plugin/Settings.md": "settings\n" });

		const diff = await uncommittedDiff(dir, ["obsidian-plugin/Settings.md"], NOT_SENT);

		expect(diff).toContain("New file: obsidian-plugin/Settings.md\nsettings\n");
	});

	it("leaves out files never sent to Claude, even when asked for them", async () => {
		const dir = await vault();
		write(dir, {
			"Instructions.md": "changed\n",
			"obsidian-plugin/_draft.md": "changed\n",
			"obsidian-plugin/.comments/Hooks.json": "{\"changed\":true}\n",
			"obsidian-plugin/Hooks.md": "hooks changed\n",
		});

		const diff = await uncommittedDiff(
			dir,
			["Instructions.md", "obsidian-plugin/_draft.md", "obsidian-plugin/.comments/Hooks.json", "obsidian-plugin/Hooks.md"],
			NOT_SENT,
		);

		expect(diff).toContain("obsidian-plugin/Hooks.md");
		expect(diff).not.toContain("Instructions.md");
		expect(diff).not.toContain("_draft.md");
		expect(diff).not.toContain(".comments");
	});

	it("is empty when every asked-for file is never sent", async () => {
		const dir = await vault();
		write(dir, { "obsidian-plugin/_draft.md": "changed\n" });

		expect(await uncommittedDiff(dir, ["obsidian-plugin/_draft.md"], NOT_SENT)).toBe("");
	});
});
