import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { GIT_MISSING, commit, savedAuthorOffer, gitIdentity, missingIdentity, requireIdentity, useSavedAuthor } from "../src/vault";
import { initRepo, out, tempFolder } from "./helpers";

const globalConfig = process.env.GIT_CONFIG_GLOBAL;

/** Points git's global config at a new file holding `text`, until the test ends. */
function globalGit(text: string): string {
	const path = join(tempFolder(), "gitconfig");
	writeFileSync(path, text);
	process.env.GIT_CONFIG_GLOBAL = path;
	return path;
}

afterEach(() => {
	process.env.GIT_CONFIG_GLOBAL = globalConfig;
});

describe("the git identity (CFG-34 to CFG-37)", () => {
	it("reads the vault's own config before the global one", async () => {
		const vault = tempFolder();
		await initRepo(vault);
		expect(await gitIdentity(vault)).toEqual({ kind: "found", name: "Test Author", email: "test@example.com" });

		await out(vault, ["config", "user.name", "Ada Engineer"]);
		expect(await gitIdentity(vault)).toEqual({ kind: "found", name: "Ada Engineer", email: "test@example.com" });

		await out(vault, ["commit", "--allow-empty", "-m", "x"]);
		expect(await out(vault, ["log", "-1", "--format=%an <%ae>"])).toBe("Ada Engineer <test@example.com>");
	});

	it("reads the global config in a folder that isn't set up yet", async () => {
		expect(await gitIdentity(tempFolder())).toEqual({ kind: "found", name: "Test Author", email: "test@example.com" });
	});

	it("says when git can't be found", async () => {
		const vault = tempFolder();
		expect(await gitIdentity(vault, "theory-no-such-git")).toEqual({ kind: "no-git" });
		expect(GIT_MISSING).toBe("theory.md needs git, and can't find it. Install git from git-scm.com, then reopen Obsidian.");
	});

	it("names a missing name or email, and commits nothing without them", async () => {
		const vault = tempFolder();
		await initRepo(vault);
		const head = await out(vault, ["rev-parse", "HEAD"]);
		globalGit("[user]\n\tname = Ada Engineer\n");

		const identity = await gitIdentity(vault);
		expect(identity).toEqual({ kind: "found", name: "Ada Engineer", email: "" });
		expect(missingIdentity({ name: "Ada", email: "" })).toEqual(["email"]);
		expect(missingIdentity({ name: "", email: "" })).toEqual(["name", "email"]);
		expect(missingIdentity({ name: "Ada", email: "ada@example.com" })).toEqual([]);

		await expect(requireIdentity(vault)).rejects.toThrow("Set your name and email in git first. theory.md settings show how.");
		writeFileSync(join(vault, "A.md"), "a\n");
		await expect(commit(vault, "Add A", ["A.md"])).rejects.toThrow("Set your name and email in git first.");
		expect(await out(vault, ["rev-parse", "HEAD"])).toBe(head);
	});

	it("offers an older saved author only when git lacks a name or email", () => {
		const saved = { fullName: "Ada Engineer", email: "ada@example.com" };
		expect(savedAuthorOffer({ kind: "found", name: "Ada", email: "" }, saved)).toEqual({ name: "Ada Engineer", email: "ada@example.com" });
		expect(savedAuthorOffer({ kind: "found", name: "Git Name", email: "git@example.com" }, saved)).toBeNull();
		expect(savedAuthorOffer({ kind: "no-git" }, saved)).toBeNull();
		expect(savedAuthorOffer({ kind: "found", name: "", email: "" }, { fullName: "Ada", email: "" })).toBeNull();
	});

	it("writes an older saved author into the vault's config only, never the global one", async () => {
		const vault = tempFolder();
		await initRepo(vault);
		const global = globalGit("[user]\n\tname = Someone Else\n");

		await useSavedAuthor(vault, { name: "Ada Engineer", email: "ada@example.com" });

		expect(await out(vault, ["config", "--local", "user.name"])).toBe("Ada Engineer");
		expect(await out(vault, ["config", "--local", "user.email"])).toBe("ada@example.com");
		expect(readFileSync(global, "utf8")).toBe("[user]\n\tname = Someone Else\n");
		expect(await requireIdentity(vault)).toEqual({ name: "Ada Engineer", email: "ada@example.com" });
	});

	it("refuses to write an older saved author into a vault that isn't set up", async () => {
		await expect(useSavedAuthor(tempFolder(), { name: "Ada", email: "ada@example.com" })).rejects.toThrow("Set up the vault first.");
	});
});
