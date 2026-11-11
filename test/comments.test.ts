import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
	CommentFile,
	commentAnchor,
	commentFilePath,
	deleteComments,
	frontMatterEnd,
	groupThreads,
	listCommentFiles,
	moveComments,
	notePathOf,
	orderThreads,
	parseComments,
	readCommentFile,
	saveComment,
	unreadableMessage,
} from "../src/comments";
import { changedFiles } from "../src/vault";
import { initRepo, out, tempFolder, write } from "./helpers";

const ANA = { name: "Ana Lee", email: "ana@example.com" };
const FOLDERS = ["obsidian-plugin", "theory-server"];
const AT = new Date("2026-11-04T08:42:00Z");

/** Paths in the newest commit, and its subject and author. */
async function lastCommit(vault: string) {
	const [head, ...paths] = (await out(vault, ["show", "--name-only", "--no-renames", "--format=%s|%an <%ae>", "HEAD"])).split("\n").filter(Boolean);
	return { head, paths: paths.sort() };
}

async function vaultWith(files: Record<string, string>) {
	const vault = tempFolder();
	await initRepo(vault, files);
	return vault;
}

describe("comments", () => {
	it("go to the .comments folder of the note's model folder, else the vault root (CMNT-9)", () => {
		expect(commentFilePath("obsidian-plugin/Compile.md", FOLDERS)).toBe("obsidian-plugin/.comments/Compile.json");
		expect(commentFilePath("obsidian-plugin/flows/Login.md", FOLDERS)).toBe("obsidian-plugin/.comments/flows/Login.json");
		expect(commentFilePath("Index.md", FOLDERS)).toBe(".comments/Index.json");
		expect(commentFilePath("notes/Idea.md", FOLDERS)).toBe(".comments/notes/Idea.json");
		// The folder must be named exactly like the repository.
		expect(commentFilePath("Obsidian-Plugin/Compile.md", FOLDERS)).toBe(".comments/Obsidian-Plugin/Compile.json");
	});

	it("write the note's path and threads with two-space indents and a newline at the end (CMNT-10, CMNT-11)", async () => {
		const vault = await vaultWith({ "obsidian-plugin/Compile.md": "## Compile\n\nthe code must follow the model\n" });
		const { path, file } = await saveComment(
			vault,
			"obsidian-plugin/Compile.md",
			FOLDERS,
			{ kind: "comment", anchor: { heading: "Compile", quote: "the code must follow the model" }, text: "What about hotfixes?" },
			ANA,
			AT,
		);

		expect(path).toBe("obsidian-plugin/.comments/Compile.json");
		const text = readFileSync(join(vault, path), "utf8");
		expect(text.endsWith("}\n")).toBe(true);
		expect(text).toContain('\n  "threads": [\n    {\n      "id": ');
		const thread = file.threads[0];
		expect(JSON.parse(text)).toEqual({
			version: 1,
			note: "obsidian-plugin/Compile.md",
			threads: [
				{
					id: thread.id,
					anchor: { heading: "Compile", quote: "the code must follow the model" },
					comments: [{ id: thread.comments[0].id, author: ANA, at: "2026-11-04T08:42:00.000Z", text: "What about hotfixes?" }],
					resolved: null,
				},
			],
		});
		expect(thread.id).toMatch(/^[a-z0-9]{6}$/);
	});

	it("keep fields they don't know when written again", async () => {
		const vault = await vaultWith({ "Index.md": "hello\n" });
		const existing = { version: 1, note: "Index.md", later: "kept", threads: [] };
		write(vault, { ".comments/Index.json": JSON.stringify(existing, null, 2) + "\n" });
		await saveComment(vault, "Index.md", FOLDERS, { kind: "comment", anchor: { quote: "hello" }, text: "Hi" }, ANA, AT);
		expect(JSON.parse(readFileSync(join(vault, ".comments/Index.json"), "utf8")).later).toBe("kept");
	});

	it("reply, resolve and reopen, each committed on its own (CMNT-13)", async () => {
		const vault = await vaultWith({ "theory-server/flows/Login.md": "log in\n" });
		const note = "theory-server/flows/Login.md";
		const first = await saveComment(vault, note, FOLDERS, { kind: "comment", anchor: { quote: "log in" }, text: "Why?" }, ANA, AT);
		expect(await lastCommit(vault)).toEqual({ head: "Comment on Login|Test Author <test@example.com>", paths: [first.path] });

		const threadId = first.file.threads[0].id;
		const bo = { name: "Bo Kim", email: "bo@example.com" };
		const replied = await saveComment(vault, note, FOLDERS, { kind: "reply", threadId, text: "Because." }, bo, AT);
		expect(replied.file.threads[0].comments.map((c) => c.text)).toEqual(["Why?", "Because."]);
		expect((await lastCommit(vault)).head).toMatch(/^Reply on Login\|/);

		const resolved = await saveComment(vault, note, FOLDERS, { kind: "resolve", threadId }, bo, AT);
		expect(resolved.file.threads[0].resolved).toEqual({ by: bo, at: "2026-11-04T08:42:00.000Z" });
		expect((await lastCommit(vault)).head).toMatch(/^Resolve a comment on Login\|/);

		const reopened = await saveComment(vault, note, FOLDERS, { kind: "reopen", threadId }, ANA, AT);
		expect(reopened.file.threads[0].resolved).toBeNull();
		expect((await lastCommit(vault)).head).toMatch(/^Reopen a comment on Login\|/);
		expect(await changedFiles(vault)).toEqual([]);
	});

	it("commit only the comment file, never the note or other changes (CMNT-2, CMNT-13)", async () => {
		const vault = await vaultWith({ "Index.md": "hello\n", "Other.md": "o\n" });
		write(vault, { "Index.md": "hello, edited\n", "Other.md": "o2\n" });
		await out(vault, ["add", "Other.md"]);

		await saveComment(vault, "Index.md", FOLDERS, { kind: "comment", anchor: { quote: "hello" }, text: "Hi" }, ANA, AT);

		expect((await lastCommit(vault)).paths).toEqual([".comments/Index.json"]);
		expect(readFileSync(join(vault, "Index.md"), "utf8")).toBe("hello, edited\n");
		expect((await changedFiles(vault)).sort()).toEqual(["Index.md", "Other.md"]);
	});

	it("stay saved when the commit fails, and go with the next comment's commit (CMNT-14)", async () => {
		const vault = tempFolder();
		write(vault, { "Index.md": "hello\n" });
		// Not a git repository yet, so the commit fails.
		const result = await saveComment(vault, "Index.md", FOLDERS, { kind: "comment", anchor: { quote: "hello" }, text: "Hi" }, ANA, AT);
		expect(result.notCommitted).not.toBeNull();
		expect(existsSync(join(vault, ".comments/Index.json"))).toBe(true);

		await out(vault, ["init", "-b", "main"]);
		const next = await saveComment(vault, "Index.md", FOLDERS, { kind: "comment", anchor: { quote: "hello" }, text: "Again" }, ANA, AT);
		expect(next.notCommitted).toBeNull();
		expect(next.file.threads).toHaveLength(2);
		expect(await out(vault, ["show", "HEAD:.comments/Index.json"])).toContain("Again");
	});

	it("never overwrite a file they can't read (CMNT-12)", async () => {
		const vault = await vaultWith({ "Index.md": "hello\n" });
		write(vault, { ".comments/Index.json": "{ not json" });
		const head = await out(vault, ["rev-parse", "HEAD"]);

		expect(await readCommentFile(vault, ".comments/Index.json")).toEqual({ kind: "broken" });
		await expect(
			saveComment(vault, "Index.md", FOLDERS, { kind: "comment", anchor: { quote: "hello" }, text: "Hi" }, ANA, AT),
		).rejects.toThrow("The comments on Index can't be read: .comments/Index.json.");
		expect(readFileSync(join(vault, ".comments/Index.json"), "utf8")).toBe("{ not json");
		expect(await out(vault, ["rev-parse", "HEAD"])).toBe(head);
		expect(parseComments('{"version":2,"note":"Index.md","threads":[]}')).toBeNull();
		expect(parseComments('{"version":1,"note":"Index.md","threads":[{"id":"a"}]}')).toBeNull();
	});

	it("move with their note, committed at once (CMNT-15)", async () => {
		const vault = await vaultWith({ "obsidian-plugin/Compile.md": "compile\n" });
		await saveComment(vault, "obsidian-plugin/Compile.md", FOLDERS, { kind: "comment", anchor: { quote: "compile" }, text: "Hi" }, ANA, AT);

		expect(await moveComments(vault, "obsidian-plugin/Compile.md", "obsidian-plugin/flows/Build.md", FOLDERS)).toBe(true);

		expect(existsSync(join(vault, "obsidian-plugin/.comments/Compile.json"))).toBe(false);
		const moved = JSON.parse(readFileSync(join(vault, "obsidian-plugin/.comments/flows/Build.json"), "utf8"));
		expect(moved.note).toBe("obsidian-plugin/flows/Build.md");
		expect(moved.threads[0].comments[0].text).toBe("Hi");
		expect(await lastCommit(vault)).toEqual({
			head: "Move comments on Build|Test Author <test@example.com>",
			paths: ["obsidian-plugin/.comments/Compile.json", "obsidian-plugin/.comments/flows/Build.json"],
		});
		// Out of the model folder: the root `.comments/`.
		await moveComments(vault, "obsidian-plugin/flows/Build.md", "Build.md", FOLDERS);
		expect(existsSync(join(vault, ".comments/Build.json"))).toBe(true);
		expect(await moveComments(vault, "Nothing.md", "Else.md", FOLDERS)).toBe(false);
	});

	it("are deleted with their note, and stay in git history (CMNT-15)", async () => {
		const vault = await vaultWith({ "Index.md": "hello\n" });
		await saveComment(vault, "Index.md", FOLDERS, { kind: "comment", anchor: { quote: "hello" }, text: "Hi" }, ANA, AT);

		expect(await deleteComments(vault, "Index.md", FOLDERS)).toBe(true);
		expect(existsSync(join(vault, ".comments/Index.json"))).toBe(false);
		expect(await lastCommit(vault)).toEqual({ head: "Delete comments on Index|Test Author <test@example.com>", paths: [".comments/Index.json"] });
		expect(await out(vault, ["show", "HEAD~1:.comments/Index.json"])).toContain("Hi");
	});

	it("are anchored to the nearest heading above the selection and its text (CMNT-7)", () => {
		const text = "---\nrealized: false\n---\n# Title\n\n## Compile\n\n```\n## Not a heading\n```\nthe code must follow the model\n";
		const offset = text.indexOf("the code");
		expect(commentAnchor(text, offset, " the code must follow ")).toEqual({ heading: "Compile", quote: "the code must follow" });
		expect(commentAnchor("no heading here", 3, "heading")).toEqual({ quote: "heading" });
		expect(frontMatterEnd(text)).toBe("---\nrealized: false\n---\n".length);
		expect(frontMatterEnd("# No front matter\n")).toBe(0);
	});

	it("show open threads in the order their quotes appear, then changed ones, with resolved ones apart (CMNT-17, CMNT-20)", () => {
		const thread = (id: string, quote: string, resolved = false) => ({
			id,
			anchor: { quote },
			comments: [],
			resolved: resolved ? { by: ANA, at: AT.toISOString() } : null,
		});
		const file: CommentFile = {
			version: 1,
			note: "A.md",
			threads: [thread("c", "third"), thread("gone", "removed text"), thread("a", "first"), thread("r", "second", true)],
		};
		const { open, resolved } = orderThreads(file, "first second third");
		expect(open.map((t) => [t.thread.id, t.at !== null])).toEqual([
			["a", true],
			["c", true],
			["gone", false],
		]);
		expect(resolved.map((t) => t.id)).toEqual(["r"]);
	});

	it("name the note in the message for a file they can't read (CMNT-12)", () => {
		expect(unreadableMessage("obsidian-plugin/Compile.md", "obsidian-plugin/.comments/Compile.json")).toBe(
			"The comments on obsidian-plugin/Compile can't be read: obsidian-plugin/.comments/Compile.json.",
		);
	});
});

describe("the Comments view over every note (CMNT-16, CMNT-17, CMNT-19)", () => {
	const comment = (at: string) => ({ id: at, author: ANA, at, text: "Hi" });
	const thread = (id: string, quote: string, at: string, resolved = false) => ({
		id,
		anchor: { quote },
		comments: [comment(at)],
		resolved: resolved ? { by: ANA, at } : null,
	});
	const file = (note: string, threads: ReturnType<typeof thread>[]): CommentFile => ({ version: 1, note, threads });

	it("finds every comment file in the vault, in model folders and at the root, and the note each belongs to", async () => {
		const vault = tempFolder();
		write(vault, {
			".comments/Index.json": "{}",
			"obsidian-plugin/.comments/Compile.json": "{}",
			"obsidian-plugin/.comments/flows/Login.json": "{}",
			"obsidian-plugin/Compile.md": "text",
			"other/.comments/Stray.json": "{}",
		});

		const found = await listCommentFiles(vault, FOLDERS);

		expect(found.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
			{ note: "Index.md", path: ".comments/Index.json" },
			{ note: "obsidian-plugin/Compile.md", path: "obsidian-plugin/.comments/Compile.json" },
			{ note: "obsidian-plugin/flows/Login.md", path: "obsidian-plugin/.comments/flows/Login.json" },
		]);
		expect(notePathOf(commentFilePath("obsidian-plugin/flows/Login.md", FOLDERS), FOLDERS)).toBe("obsidian-plugin/flows/Login.md");
		expect(notePathOf(commentFilePath("Index.md", FOLDERS), FOLDERS)).toBe("Index.md");
	});

	it("groups open threads by note, newest comment first, each group by its path without .md, threads in quote order", () => {
		const { open, resolved } = groupThreads([
			{ note: "Index.md", file: file("Index.md", [thread("i", "hello", "2026-11-01T00:00:00Z")]), text: "hello" },
			{
				note: "obsidian-plugin/Compile.md",
				file: file("obsidian-plugin/Compile.md", [
					thread("b", "second", "2026-11-02T00:00:00Z"),
					thread("a", "first", "2026-11-03T00:00:00Z"),
					thread("r", "first", "2026-11-09T00:00:00Z", true),
				]),
				text: "first second",
			},
		]);

		expect(open.map((g) => [g.label, g.threads.map((t) => t.thread.id)])).toEqual([
			["obsidian-plugin/Compile", ["a", "b"]],
			["Index", ["i"]],
		]);
		expect(resolved.map((g) => [g.label, g.threads.map((t) => t.thread.id)])).toEqual([["obsidian-plugin/Compile", ["r"]]]);
	});

	it("shows a note's threads even when the note is gone, as changed text, and nothing for a vault without comments", () => {
		const { open } = groupThreads([{ note: "Gone.md", file: file("Gone.md", [thread("g", "old", "2026-11-01T00:00:00Z")]), text: null }]);
		expect(open[0].threads[0].at).toBeNull();
		expect(groupThreads([{ note: "A.md", file: file("A.md", []), text: "" }])).toEqual({ open: [], resolved: [] });
	});
});
