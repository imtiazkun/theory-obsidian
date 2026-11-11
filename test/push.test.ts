import { join } from "path";
import { describe, expect, it } from "vitest";
import { commitNotice, pushNotice, pushVault } from "../src/push";
import { syncMenu, type SyncState } from "../src/pull";
import { git } from "../src/vault";
import { commitFiles, initRepo, out, tempFolder } from "./helpers";

/** A bare `origin`, the vault cloned from it, and a teammate's clone that pushes to it. */
async function shared() {
	const root = tempFolder();
	const seed = join(root, "seed");
	const origin = join(root, "origin.git");
	await initRepo(seed, { "Index.md": "index\n" });
	await git(root, ["clone", "--bare", "--quiet", seed, origin]);
	const vault = join(root, "vault");
	const ana = join(root, "ana");
	await git(root, ["clone", "--quiet", origin, vault]);
	await git(root, ["clone", "--quiet", origin, ana]);
	return { root, origin, vault, ana };
}

describe("pushing after a commit (CMT-30 to CMT-37)", () => {
	it("pushes main with every revision not pushed yet", async () => {
		const { origin, vault } = await shared();
		await commitFiles(vault, { "A.md": "a\n" }, "First");
		const head = await commitFiles(vault, { "B.md": "b\n" }, "Second");

		expect(await pushVault(vault)).toEqual({ kind: "pushed" });
		expect(await out(origin, ["rev-parse", "main"])).toBe(head);
	});

	it("never pushes tags, so the last compile marker stays on this machine", async () => {
		const { origin, vault } = await shared();
		await commitFiles(vault, { "A.md": "a\n" }, "First");
		await git(vault, ["tag", "theory/compiled"]);

		await pushVault(vault);

		expect(await out(origin, ["tag", "--list"])).toBe("");
	});

	it("is refused, never forced, when the remote has new revisions, and the commit stays", async () => {
		const { origin, vault, ana } = await shared();
		const theirs = await commitFiles(ana, { "Ana.md": "ana\n" }, "Ana's");
		await git(ana, ["push", "--quiet", "origin", "main"]);
		const mine = await commitFiles(vault, { "A.md": "a\n" }, "Mine");

		const result = await pushVault(vault);

		expect(result).toEqual({ kind: "rejected" });
		expect(await out(origin, ["rev-parse", "main"])).toBe(theirs);
		expect(await out(vault, ["rev-parse", "HEAD"])).toBe(mine);
		expect(commitNotice("abc1234", result)).toBe(
			"Committed abc1234, but couldn't push: the remote has new revisions. Pull with rebase in git, then push.",
		);
	});

	it("fails with git's message when the remote can't be reached, without waiting for a password", async () => {
		const { root, vault } = await shared();
		await git(vault, ["remote", "set-url", "origin", join(root, "gone.git")]);
		const mine = await commitFiles(vault, { "A.md": "a\n" }, "Mine");

		const result = await pushVault(vault);

		expect(result.kind).toBe("failed");
		expect(await out(vault, ["rev-parse", "HEAD"])).toBe(mine);
		expect(commitNotice("abc1234", result)).toMatch(/^Committed abc1234, but couldn't push: .+/);
	});

	it("doesn't push without an origin, and the notice stays plain", async () => {
		const vault = tempFolder();
		await initRepo(vault);

		const result = await pushVault(vault);

		expect(result).toEqual({ kind: "no-origin" });
		expect(commitNotice("abc1234", result)).toBe("Committed abc1234");
		expect(commitNotice("abc1234", { kind: "pushed" })).toBe("Committed and pushed abc1234");
		expect(pushNotice({ kind: "rejected" })).toBe(
			"Couldn't push: the remote has new revisions. Pull with rebase in git, then push.",
		);
	});
});

describe("Push now in the sync menu (PULL-19)", () => {
	const state = (ahead: number, pushing = false): SyncState => ({
		running: false,
		origin: true,
		vault: { kind: "synced", ahead },
		lastSynced: 0,
		lastPulled: null,
		pushing,
	});

	it("shows when the vault has revisions that aren't pushed", () => {
		expect(syncMenu(state(2), 0).push).toEqual({ label: "Push now", enabled: true });
		expect(syncMenu(state(2, true), 0).push).toEqual({ label: "Pushing…", enabled: false });
	});

	it("doesn't show when everything is pushed, or without a remote", () => {
		expect(syncMenu(state(0), 0).push).toBeNull();
		expect(syncMenu({ ...state(2), origin: false }, 0).push).toBeNull();
	});
});
