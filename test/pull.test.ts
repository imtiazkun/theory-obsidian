import { mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
	FOCUS_PULL_GAP_MS,
	NO_PROMPT_ENV,
	PullOutcome,
	PullReason,
	Puller,
	SyncState,
	VaultPull,
	compileGate,
	fastForwardRepo,
	pullRepos,
	pullVault,
	pulledNotice,
	repoPullState,
	syncStatus,
} from "../src/pull";
import { git } from "../src/vault";
import { commitFiles, initRepo, out, tempFolder, write } from "./helpers";

const ANA = ["-c", "user.name=Ana Lee", "-c", "user.email=ana@example.com"];

/** A bare `origin`, the vault cloned from it, and a teammate's clone that pushes to it. */
async function vaultWithOrigin(files: Record<string, string> = { "Compile.md": "compile\n", "Agents.md": "agents\n" }) {
	const root = tempFolder();
	const seed = join(root, "seed");
	await initRepo(seed, files);
	const origin = join(root, "origin.git");
	await git(root, ["clone", "--bare", "--quiet", seed, origin]);
	const vault = join(root, "vault");
	const ana = join(root, "ana");
	await git(root, ["clone", "--quiet", origin, vault]);
	await git(root, ["clone", "--quiet", origin, ana]);
	return { root, origin, vault, ana };
}

/** Ana commits `files` and pushes them to origin. */
async function anaPushes(ana: string, files: Record<string, string>, message = "Ana's change") {
	write(ana, files);
	await git(ana, ["add", "-A"]);
	await git(ana, [...ANA, "commit", "-m", message]);
	await git(ana, ["push", "--quiet", "origin", "main"]);
}

const read = (path: string) => readFileSync(path, "utf8");

describe("vault pull", () => {
	it("never pulls a vault without an origin, and hides the sync status", async () => {
		const vault = join(tempFolder(), "vault");
		await initRepo(vault);
		const pull = await pullVault(vault, "");
		expect(pull).toEqual({ kind: "no-origin" });
		expect(syncStatus({ running: true, vault: pull, lastSynced: null }, Date.now())).toBeNull();
	});

	it("changes nothing when the remote has nothing new, and counts revisions not pushed", async () => {
		const { vault } = await vaultWithOrigin();
		expect(await pullVault(vault, "")).toEqual({ kind: "synced", ahead: 0 });
		await commitFiles(vault, { "Compile.md": "mine\n" }, "Mine");
		const head = await out(vault, ["rev-parse", "HEAD"]);
		const pull = await pullVault(vault, "");
		expect(pull).toEqual({ kind: "synced", ahead: 1 });
		expect(await out(vault, ["rev-parse", "HEAD"])).toBe(head);
		expect(syncStatus({ running: false, vault: pull, lastSynced: Date.now() }, Date.now())?.label).toBe(
			"Synced less than a minute ago · 1 not pushed",
		);
	});

	it("fast-forwards when only the remote moved, names the authors and notes, and leaves out the engineer's own", async () => {
		const { vault, ana } = await vaultWithOrigin();
		await anaPushes(ana, { "Compile.md": "ana compile\n" });
		await anaPushes(ana, { "Agents.md": "ana agents\n" });
		write(ana, { "Index.md": "mine\n" });
		await git(ana, ["add", "-A"]);
		await git(ana, ["commit", "-m", "Mine, from another laptop"]);
		await git(ana, ["push", "--quiet", "origin", "main"]);
		// An uncommitted file the pulled revisions don't touch stays as it is.
		write(vault, { "Draft.md": "unfinished\n" });

		const pull = await pullVault(vault, "test@example.com");
		expect(pull.kind).toBe("pulled");
		expect(read(join(vault, "Compile.md"))).toBe("ana compile\n");
		expect(read(join(vault, "Draft.md"))).toBe("unfinished\n");
		expect(await out(vault, ["rev-parse", "HEAD"])).toBe(await out(ana, ["rev-parse", "HEAD"]));
		expect(pulledNotice(pull as Extract<VaultPull, { kind: "pulled" }>)).toBe(
			"Pulled 3 revisions by Ana Lee. Changed: Compile, Agents, Index.",
		);
	});

	it("never merges, commits, pushes or moves the compile marker", async () => {
		const { vault, ana, origin } = await vaultWithOrigin();
		await git(vault, ["tag", "theory/compiled"]);
		const marker = await out(vault, ["rev-parse", "refs/tags/theory/compiled"]);
		await anaPushes(ana, { "Compile.md": "ana\n" });
		const originHead = await out(origin, ["rev-parse", "main"]);
		await pullVault(vault, "");
		expect(await out(vault, ["rev-list", "--merges", "--count", "HEAD"])).toBe("0");
		expect(await out(vault, ["rev-parse", "HEAD"])).toBe(originHead);
		expect(await out(origin, ["rev-parse", "main"])).toBe(originHead);
		expect(await out(vault, ["rev-parse", "refs/tags/theory/compiled"])).toBe(marker);
	});

	it("holds revisions back that touch a file with uncommitted changes", async () => {
		const { vault, ana } = await vaultWithOrigin();
		await anaPushes(ana, { "Compile.md": "ana\n" });
		write(vault, { "Compile.md": "my unfinished edit\n" });
		const head = await out(vault, ["rev-parse", "HEAD"]);

		const pull = await pullVault(vault, "");
		expect(pull).toEqual({ kind: "waiting", count: 1, files: ["Compile.md"] });
		expect(read(join(vault, "Compile.md"))).toBe("my unfinished edit\n");
		expect(await out(vault, ["rev-parse", "HEAD"])).toBe(head);
		const status = syncStatus({ running: false, vault: pull, lastSynced: Date.now() }, Date.now());
		expect(status?.label).toBe("1 waiting");
		expect(status?.tooltip).toContain("Compile.md");
	});

	it("holds back a new remote note when an untracked file has its path", async () => {
		const { vault, ana } = await vaultWithOrigin();
		await anaPushes(ana, { "New.md": "ana\n" });
		write(vault, { "New.md": "mine\n" });
		expect((await pullVault(vault, "")).kind).toBe("waiting");
		expect(read(join(vault, "New.md"))).toBe("mine\n");
	});

	it("changes nothing and says a sync is needed when both sides moved", async () => {
		const { vault, ana } = await vaultWithOrigin();
		await anaPushes(ana, { "Compile.md": "ana\n" });
		await commitFiles(vault, { "Agents.md": "mine\n" }, "Mine");
		const head = await out(vault, ["rev-parse", "HEAD"]);
		const pull = await pullVault(vault, "");
		expect(pull).toEqual({ kind: "diverged" });
		expect(await out(vault, ["rev-parse", "HEAD"])).toBe(head);
		const status = syncStatus({ running: false, vault: pull, lastSynced: null }, Date.now());
		expect(status?.label).toBe("Sync needed");
		expect(status?.tooltip).toBe("Your revisions and the remote's both moved. Pull with rebase in git, then pull again.");
	});

	it("changes nothing when the fetch fails, and shows git's message", async () => {
		const { vault, root } = await vaultWithOrigin();
		await git(vault, ["remote", "set-url", "origin", join(root, "gone.git")]);
		const head = await out(vault, ["rev-parse", "HEAD"]);
		const pull = await pullVault(vault, "");
		expect(pull.kind).toBe("offline");
		expect(await out(vault, ["rev-parse", "HEAD"])).toBe(head);
		const lastSynced = Date.now() - 6 * 60_000;
		const status = syncStatus({ running: false, vault: pull, lastSynced }, Date.now());
		expect(status?.label).toBe("Offline, 6 min ago");
		expect(status?.tooltip).toBe((pull as { message: string }).message);
	});

	it("runs git with its prompts turned off", () => {
		expect(NO_PROMPT_ENV.GIT_TERMINAL_PROMPT).toBe("0");
		expect(NO_PROMPT_ENV.GIT_SSH_COMMAND).toContain("BatchMode=yes");
	});
});

describe("sync status", () => {
	it("never says Up to date", () => {
		const now = Date.now();
		const states: SyncState[] = [
			{ running: true, vault: null, lastSynced: null },
			{ running: false, vault: { kind: "synced", ahead: 0 }, lastSynced: now },
			{ running: false, vault: { kind: "pulled", ahead: 0, count: 1, authors: [], notes: [] }, lastSynced: now },
			{ running: false, vault: { kind: "waiting", count: 2, files: ["a.md"] }, lastSynced: now },
			{ running: false, vault: { kind: "diverged" }, lastSynced: now },
			{ running: false, vault: { kind: "offline", message: "no" }, lastSynced: now },
		];
		const labels = states.map((state) => syncStatus(state, now)?.label);
		expect(labels).toEqual([
			"Pulling…",
			"Synced less than a minute ago",
			"Synced less than a minute ago",
			"2 waiting",
			"Sync needed",
			"Offline, less than a minute ago",
		]);
		for (const label of labels) expect(label).not.toContain("Up to date");
	});
});

/** A code repository cloned from its own bare origin, with a teammate's clone that pushes to it. */
async function codeRepo(project: string, name: string) {
	mkdirSync(project, { recursive: true });
	const seed = join(project, "..", `${name}-seed`);
	await initRepo(seed, { "main.go": "package main\n" });
	const origin = join(project, "..", `${name}.git`);
	await git(project, ["clone", "--bare", "--quiet", seed, origin]);
	const repo = join(project, name);
	const other = join(project, "..", `${name}-other`);
	await git(project, ["clone", "--quiet", origin, repo]);
	await git(project, ["clone", "--quiet", origin, other]);
	return { repo, other, origin };
}

describe("code repository pull", () => {
	it("fast-forwards a clean repository that is only behind, and leaves the rest alone", async () => {
		const project = join(tempFolder(), "project");
		const safe = await codeRepo(project, "safe");
		const dirty = await codeRepo(project, "dirty");
		const compiling = await codeRepo(project, "compiling");
		const diverged = await codeRepo(project, "diverged");
		for (const r of [safe, dirty, compiling, diverged]) await anaPushes(r.other, { "main.go": "package main // new\n" });
		write(dirty.repo, { "wip.go": "wip\n" });
		await git(compiling.repo, ["checkout", "--quiet", "-b", "theory/compile-abc1234", "--track", "origin/main"]);
		await commitFiles(diverged.repo, { "mine.go": "mine\n" }, "Mine");
		const heads = {
			dirty: await out(dirty.repo, ["rev-parse", "HEAD"]),
			compiling: await out(compiling.repo, ["rev-parse", "HEAD"]),
			diverged: await out(diverged.repo, ["rev-parse", "HEAD"]),
		};

		const results = await pullRepos(
			[safe, dirty, compiling, diverged].map((r, i) => ({ path: r.repo, name: ["safe", "dirty", "compiling", "diverged"][i] })),
		);
		const byName = Object.fromEntries(results.map((r) => [r.name, r]));
		expect(byName.safe).toMatchObject({ pulled: true, stuck: false, fetchError: null });
		expect(await out(safe.repo, ["rev-parse", "HEAD"])).toBe(await out(safe.other, ["rev-parse", "HEAD"]));
		expect(byName.dirty).toMatchObject({ pulled: false, stuck: true });
		expect(byName.compiling).toMatchObject({ pulled: false, stuck: false });
		expect(byName.diverged).toMatchObject({ pulled: false, stuck: true });
		expect(await out(dirty.repo, ["rev-parse", "HEAD"])).toBe(heads.dirty);
		expect(read(join(dirty.repo, "wip.go"))).toBe("wip\n");
		expect(await out(compiling.repo, ["rev-parse", "HEAD"])).toBe(heads.compiling);
		expect(await out(compiling.repo, ["symbolic-ref", "--short", "HEAD"])).toBe("theory/compile-abc1234");
		expect(await out(diverged.repo, ["rev-parse", "HEAD"])).toBe(heads.diverged);
		// The fetch still happened in every repository.
		expect(await out(dirty.repo, ["rev-parse", "@{u}"])).toBe(await out(dirty.other, ["rev-parse", "HEAD"]));
	});

	it("skips a repository without an upstream", async () => {
		const project = join(tempFolder(), "project");
		await initRepo(join(project, "local"));
		expect(await pullRepos([{ path: join(project, "local"), name: "local" }])).toEqual([]);
	});

	it("offers Pull only when the repository could fast-forward, and Pull moves only that one", async () => {
		const project = join(tempFolder(), "project");
		const a = await codeRepo(project, "a");
		const b = await codeRepo(project, "b");
		await anaPushes(a.other, { "main.go": "new\n" });
		await anaPushes(b.other, { "main.go": "new\n" });
		await git(a.repo, ["fetch", "--quiet"]);
		await git(b.repo, ["fetch", "--quiet"]);
		expect((await repoPullState(a.repo))?.canFastForward).toBe(true);
		const bHead = await out(b.repo, ["rev-parse", "HEAD"]);
		expect(await fastForwardRepo(a.repo)).toBe(true);
		expect(await out(a.repo, ["rev-parse", "HEAD"])).toBe(await out(a.other, ["rev-parse", "HEAD"]));
		expect(await out(b.repo, ["rev-parse", "HEAD"])).toBe(bHead);
		expect((await repoPullState(a.repo))?.canFastForward).toBe(false);
		write(b.repo, { "wip.go": "wip\n" });
		expect((await repoPullState(b.repo))?.canFastForward).toBe(false);
		expect(await fastForwardRepo(b.repo)).toBe(false);
	});
});

describe("the pull before a compile", () => {
	const repo = (over: Partial<{ name: string; fetchError: string | null; pulled: boolean; stuck: boolean }>) => ({
		path: "/x",
		name: "api",
		fetchError: null,
		pulled: false,
		stuck: false,
		...over,
	});

	it("stops the compile when a sync is needed", () => {
		expect(compileGate({ kind: "diverged" }, []).error).toBe(
			"The vault and its remote both have new commits. Pull with rebase in git, then compile again.",
		);
	});

	it("stops the compile when revisions are waiting", () => {
		expect(compileGate({ kind: "waiting", count: 1, files: ["Compile.md", "Agents.md"] }, []).error).toBe(
			"New revisions on the remote change notes you haven't committed: Compile.md, Agents.md. Commit or discard them, then compile again.",
		);
	});

	it("stops the compile when a repository not on a compile branch can't fast-forward", () => {
		const gate = compileGate({ kind: "synced", ahead: 0 }, [repo({ name: "api", stuck: true }), repo({ name: "web" }), repo({ name: "cli", stuck: true })]);
		expect(gate.error).toBe("Pull these repositories first: api, cli.");
	});

	it("carries on offline when a fetch fails", () => {
		expect(compileGate({ kind: "offline", message: "no" }, [])).toEqual({ error: null, offline: true });
		// A repository that couldn't fetch never stops the compile.
		expect(compileGate({ kind: "synced", ahead: 0 }, [repo({ fetchError: "no", stuck: true })])).toEqual({ error: null, offline: true });
	});

	it("carries on when everything pulled, or the vault has no origin", () => {
		expect(compileGate({ kind: "pulled", ahead: 0, count: 2, authors: ["Ana Lee"], notes: [] }, [repo({ pulled: true })])).toEqual({
			error: null,
			offline: false,
		});
		expect(compileGate({ kind: "no-origin" }, [])).toEqual({ error: null, offline: false });
		expect(compileGate(null, [])).toEqual({ error: null, offline: false });
	});

	it("fast-forwards the vault and the code before a compile, end to end", async () => {
		const { vault, ana, root } = await vaultWithOrigin();
		const project = join(root, "project");
		const api = await codeRepo(project, "api");
		await anaPushes(ana, { "Compile.md": "ana\n" });
		await anaPushes(api.other, { "main.go": "new\n" });
		const puller = new Puller({
			vaultPath: () => vault,
			projectFolder: () => project,
			automatic: () => false,
			pullCode: () => true,
			ownEmail: async () => "",
			compiling: () => true,
			changed: () => {},
			pulled: () => {},
		});
		// Even with automatic pulls off and the compile holding the lock.
		const outcome = (await puller.pull("compile"))!;
		expect(outcome.vault?.kind).toBe("pulled");
		expect(outcome.repos.map((r) => [r.name, r.pulled])).toEqual([["api", true]]);
		expect(compileGate(outcome.vault, outcome.repos)).toEqual({ error: null, offline: false });
		expect(read(join(vault, "Compile.md"))).toBe("ana\n");
		expect(read(join(api.repo, "main.go"))).toBe("new\n");
	});
});

describe("Puller", () => {
	function fakePuller(over: { automatic?: boolean; compiling?: () => boolean; now?: () => number } = {}) {
		const runs: PullReason[] = [];
		const puller = new Puller({
			// No vault and no code: each pull only records that it ran.
			vaultPath: () => null,
			projectFolder: () => "",
			automatic: () => over.automatic ?? true,
			pullCode: () => false,
			ownEmail: async () => "",
			compiling: over.compiling ?? (() => false),
			changed: () => {},
			pulled: (_outcome: PullOutcome, reason) => {
				runs.push(reason);
			},
			now: over.now,
		});
		return { puller, runs };
	}

	it("never pulls while a compile runs, and pulls once it ends", async () => {
		let compiling = true;
		const { puller, runs } = fakePuller({ compiling: () => compiling });
		expect(await puller.pull("timer")).toBeNull();
		expect(await puller.pull("focus")).toBeNull();
		expect(await puller.pull("now")).toBeNull();
		expect(runs).toEqual([]);
		compiling = false;
		await puller.compileEnded();
		expect(runs).toEqual(["now"]);
		// Only one pull was waiting.
		await puller.compileEnded();
		expect(runs).toEqual(["now"]);
	});

	it("skips a focus pull within 30 seconds of the last pull", async () => {
		let now = 1_000_000;
		const { puller, runs } = fakePuller({ now: () => now });
		await puller.pull("launch");
		now += FOCUS_PULL_GAP_MS - 1;
		expect(await puller.pull("focus")).toBeNull();
		now += 2;
		await puller.pull("focus");
		expect(runs).toEqual(["launch", "focus"]);
	});

	it("with automatic pulls off, still runs Pull now and the pull before a compile", async () => {
		const { puller, runs } = fakePuller({ automatic: false });
		for (const reason of ["launch", "focus", "timer"] as const) expect(await puller.pull(reason)).toBeNull();
		await puller.pull("now");
		await puller.pull("compile");
		expect(runs).toEqual(["now", "compile"]);
	});

	it("runs the compile's own pull after one that is already running", async () => {
		const { puller, runs } = fakePuller();
		const first = puller.pull("timer");
		const second = puller.pull("compile");
		await Promise.all([first, second]);
		expect(runs).toEqual(["timer", "compile"]);
	});
});
