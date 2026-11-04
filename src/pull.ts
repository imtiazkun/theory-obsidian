import { basename } from "path";
import { CodeRepo, currentBranch, isCompileBranch, projectRepos } from "./branches";
import { hasOrigin } from "./github";
import { git } from "./vault";

/** Git never waits for a password or passphrase: it fails with its own message instead (PULL-3). */
export const NO_PROMPT_ENV: Record<string, string> = {
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "",
	SSH_ASKPASS: "",
	GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ? `${process.env.GIT_SSH_COMMAND} -o BatchMode=yes` : "ssh -o BatchMode=yes",
};

/** A focus pull this soon after the last pull is skipped (PULL-5). */
export const FOCUS_PULL_GAP_MS = 30_000;

/** The choices for "Check every", in minutes (CFG-26). */
export const PULL_INTERVALS = [1, 5, 15, 30] as const;

const VAULT_BRANCH = "main";
const LOCAL = `refs/heads/${VAULT_BRANCH}`;
const REMOTE = `refs/remotes/origin/${VAULT_BRANCH}`;

/** How a vault pull ended (PULL-7). */
export type VaultPull =
	| { kind: "no-origin" }
	/** The vault has every revision on the remote; `ahead` are its own revisions the remote doesn't have. */
	| { kind: "synced"; ahead: number }
	/** `count` revisions fast-forwarded; `authors` wrote them, the engineer left out; `notes` changed. */
	| { kind: "pulled"; ahead: number; count: number; authors: string[]; notes: string[] }
	/** Revisions on the remote touch files with uncommitted changes, so they wait. */
	| { kind: "waiting"; count: number; files: string[] }
	/** Both the vault and the remote have new commits. */
	| { kind: "diverged" }
	| { kind: "offline"; message: string };

function gitError(error: unknown): string {
	return (error as { stderr?: string }).stderr?.trim() || (error instanceof Error ? error.message : String(error));
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
	try {
		await git(repoPath, ["rev-parse", "--verify", "--quiet", ref]);
		return true;
	} catch {
		return false;
	}
}

async function count(repoPath: string, range: string): Promise<number> {
	const { stdout } = await git(repoPath, ["rev-list", "--count", range]);
	return Number(stdout.trim());
}

/** Every path with uncommitted changes, new files and both sides of a rename included. */
async function uncommittedPaths(repoPath: string): Promise<string[]> {
	const { stdout } = await git(repoPath, ["status", "--porcelain", "-z", "--untracked-files=all"]);
	const entries = stdout.split("\0").filter(Boolean);
	const paths: string[] = [];
	for (let i = 0; i < entries.length; i++) {
		const status = entries[i].slice(0, 2);
		paths.push(entries[i].slice(3));
		// A rename or copy is followed by its original path.
		if (status.includes("R") || status.includes("C")) paths.push(entries[++i]);
	}
	return paths.filter(Boolean);
}

/** Paths any commit in `range` touched. */
async function touchedPaths(repoPath: string, range: string): Promise<Set<string>> {
	const { stdout } = await git(repoPath, ["log", "--format=", "--name-only", "-z", range]);
	return new Set(stdout.split(/[\0\n]/).filter(Boolean));
}

/** The vault's own revisions on `main` that `origin/main` doesn't have, from git's last fetch. */
async function aheadOfOrigin(vaultPath: string): Promise<number> {
	if (!(await refExists(vaultPath, LOCAL))) return 0;
	return (await refExists(vaultPath, REMOTE)) ? count(vaultPath, `${REMOTE}..${LOCAL}`) : count(vaultPath, LOCAL);
}

/**
 * Fetches the vault's `origin`, then fast-forwards `main` when that is safe (PULL-7). Never merges, rebases,
 * commits, pushes, stashes or switches branches, and never touches a file with uncommitted changes.
 * `ownEmail` is left out of the authors named after a fast-forward (PULL-8).
 */
export async function pullVault(vaultPath: string, ownEmail: string): Promise<VaultPull> {
	if (!(await hasOrigin(vaultPath))) return { kind: "no-origin" };
	try {
		await git(vaultPath, ["fetch", "--quiet", "--no-tags", "origin"], NO_PROMPT_ENV);
	} catch (error) {
		return { kind: "offline", message: gitError(error) };
	}
	if (!(await refExists(vaultPath, REMOTE)) || !(await refExists(vaultPath, LOCAL))) {
		// The remote has no main yet: everything here is the vault's own.
		return { kind: "synced", ahead: await aheadOfOrigin(vaultPath) };
	}
	const behind = await count(vaultPath, `${LOCAL}..${REMOTE}`);
	const ahead = await count(vaultPath, `${REMOTE}..${LOCAL}`);
	if (behind === 0) return { kind: "synced", ahead };
	if (ahead > 0) return { kind: "diverged" };

	const touched = await touchedPaths(vaultPath, `${LOCAL}..${REMOTE}`);
	const held = (await uncommittedPaths(vaultPath)).filter((path) => touched.has(path));
	if (held.length > 0) return { kind: "waiting", count: behind, files: held };

	const { stdout: log } = await git(vaultPath, ["log", "--reverse", "--format=%an%x1f%ae", `${LOCAL}..${REMOTE}`]);
	const authors = log
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\x1f"))
		.filter(([, email]) => !ownEmail || email.toLowerCase() !== ownEmail.toLowerCase())
		.map(([author]) => author);
	// The notes the pulled revisions changed, in the order they changed them.
	const { stdout: diff } = await git(vaultPath, ["diff", "--name-only", "-z", LOCAL, REMOTE]);
	const changed = new Set(diff.split("\0").filter(Boolean));
	const { stdout: order } = await git(vaultPath, ["log", "--reverse", "--format=", "--name-only", "-z", `${LOCAL}..${REMOTE}`]);
	const notes = [...new Set(order.split(/[\0\n]/).filter((path) => changed.has(path) && path.toLowerCase().endsWith(".md")))];

	try {
		if ((await currentBranch(vaultPath)) === VAULT_BRANCH) {
			// A fast-forward only moves main and the files it changes; git refuses rather than overwrite anything.
			await git(vaultPath, ["merge", "--ff-only", "--quiet", REMOTE], NO_PROMPT_ENV);
		} else {
			// main isn't checked out, so only its ref moves, and only from where it was.
			const { stdout: from } = await git(vaultPath, ["rev-parse", LOCAL]);
			const { stdout: to } = await git(vaultPath, ["rev-parse", REMOTE]);
			await git(vaultPath, ["update-ref", LOCAL, to.trim(), from.trim()]);
		}
	} catch (error) {
		return { kind: "offline", message: gitError(error) };
	}
	return { kind: "pulled", ahead: 0, count: behind, authors: [...new Set(authors)], notes };
}

/** The notice after a fast-forward (PULL-8): "Pulled 3 revisions by Ana Lee. Changed: Compile, Agents." */
export function pulledNotice(pull: Extract<VaultPull, { kind: "pulled" }>): string {
	const total = pull.count;
	const by = pull.authors.length > 0 ? ` by ${joinNames(pull.authors)}` : "";
	const notes = [...new Set(pull.notes.map((path) => basename(path).replace(/\.md$/i, "")))];
	const changed = notes.length > 0 ? ` Changed: ${notes.join(", ")}.` : "";
	return `Pulled ${total} ${total === 1 ? "revision" : "revisions"}${by}.${changed}`;
}

function joinNames(names: string[]): string {
	return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The vault's `origin` URL, or null when it has none. */
export async function originUrl(vaultPath: string): Promise<string | null> {
	try {
		return (await git(vaultPath, ["remote", "get-url", "origin"])).stdout.trim() || null;
	} catch {
		return null;
	}
}

// Tokens people paste as the user name of an https URL: GitHub's and GitLab's.
const TOKEN_PREFIXES = /^(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-)/;

/** Why a remote URL can't be saved (CFG-32), or null when it can. */
export function remoteUrlProblem(url: string): string | null {
	// A leading dash would reach git as an option.
	if (!url || /\s/.test(url) || url.startsWith("-")) return "Enter the remote's URL.";
	const userinfo = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)@/i.exec(url)?.[1];
	if (userinfo !== undefined && (userinfo.includes(":") || TOKEN_PREFIXES.test(userinfo))) {
		return "Don't put a password or token in the remote. Git asks your credential helper instead.";
	}
	return null;
}

/**
 * Adds the vault's `origin`, or points it at `url` (CFG-30). Never fetches or pushes.
 * Throws git's message when git refuses; the caller checks `remoteUrlProblem` first.
 */
export async function saveOrigin(vaultPath: string, url: string): Promise<"added" | "replaced" | "unchanged"> {
	const current = await originUrl(vaultPath);
	if (current === url) return "unchanged";
	try {
		await git(vaultPath, current === null ? ["remote", "add", "origin", url] : ["remote", "set-url", "origin", url]);
	} catch (error) {
		throw new Error(gitError(error));
	}
	return current === null ? "added" : "replaced";
}

/** Whether a code repository may fast-forward to its upstream (PULL-13). Null when it has no upstream. */
export interface RepoPullState {
	branch: string;
	upstream: string;
	ahead: number;
	behind: number;
	dirty: boolean;
	onCompileBranch: boolean;
	canFastForward: boolean;
}

/** Reads a repository's state against its upstream, as git last fetched it. Never fetches. */
export async function repoPullState(repoPath: string): Promise<RepoPullState | null> {
	const branch = await currentBranch(repoPath);
	if (!branch) return null;
	let upstream: string;
	try {
		upstream = (await git(repoPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).stdout.trim();
	} catch {
		return null;
	}
	if (!upstream) return null;
	const { stdout } = await git(repoPath, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
	const [ahead, behind] = stdout.trim().split(/\s+/).map(Number);
	const dirty = (await uncommittedPaths(repoPath)).length > 0;
	const onCompileBranch = isCompileBranch(branch);
	return {
		branch,
		upstream,
		ahead,
		behind,
		dirty,
		onCompileBranch,
		canFastForward: !onCompileBranch && !dirty && behind > 0 && ahead === 0,
	};
}

/** Fast-forwards one repository to its upstream when PULL-13 allows it. Returns true when it moved. */
export async function fastForwardRepo(repoPath: string): Promise<boolean> {
	const state = await repoPullState(repoPath);
	if (!state?.canFastForward) return false;
	await git(repoPath, ["merge", "--ff-only", "--quiet", "@{u}"], NO_PROMPT_ENV);
	return true;
}

/** How one code repository's pull ended. */
export interface RepoPull extends CodeRepo {
	/** Git's message when the fetch failed. */
	fetchError: string | null;
	pulled: boolean;
	/** Not on a compile branch, behind its upstream, and couldn't fast-forward. */
	stuck: boolean;
}

/** Fetches every repository with an upstream, and fast-forwards those PULL-13 allows. Never shows anything. */
export async function pullRepos(repos: CodeRepo[]): Promise<RepoPull[]> {
	const results: RepoPull[] = [];
	for (const repo of repos) {
		if (!(await repoPullState(repo.path))) continue;
		let fetchError: string | null = null;
		try {
			await git(repo.path, ["fetch", "--quiet", "--no-tags"], NO_PROMPT_ENV);
		} catch (error) {
			fetchError = gitError(error);
		}
		let pulled = false;
		try {
			pulled = await fastForwardRepo(repo.path);
		} catch {
			pulled = false;
		}
		const after = await repoPullState(repo.path);
		const stuck = after !== null && !after.onCompileBranch && after.behind > 0;
		results.push({ ...repo, fetchError, pulled, stuck });
	}
	return results;
}

/** Whether the pull before a compile stops it (PULL-16) or lets it carry on offline (PULL-17). */
export function compileGate(vault: VaultPull | null, repos: RepoPull[]): { error: string | null; offline: boolean } {
	if (vault?.kind === "diverged") {
		return { error: "The vault and its remote both have new commits. Pull with rebase in git, then compile again.", offline: false };
	}
	if (vault?.kind === "waiting") {
		return {
			error: `New revisions on the remote change notes you haven't committed: ${vault.files.join(", ")}. Commit or discard them, then compile again.`,
			offline: false,
		};
	}
	// Offline, only what git already knew is local; a repository whose fetch failed never stops the compile.
	const stuck = repos.filter((r) => r.stuck && r.fetchError === null).map((r) => r.name);
	if (stuck.length > 0) return { error: `Pull these repositories first: ${stuck.join(", ")}.`, offline: false };
	const offline = vault?.kind === "offline" || repos.some((r) => r.fetchError !== null);
	return { error: null, offline };
}

/** What the sync status shows, worked out from the last pulls. Kept only while Obsidian runs (PULL-22). */
export interface SyncState {
	running: boolean;
	/** Whether the vault has an `origin`. Null until it has been looked at, or when the vault isn't set up. */
	origin: boolean | null;
	/** Null until the vault has pulled once. */
	vault: VaultPull | null;
	/** When a vault fetch last worked. */
	lastSynced: number | null;
	/** The last pull that brought revisions. */
	lastPulled: { at: number; count: number } | null;
}

function duration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "less than a minute";
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h`;
	return `${Math.floor(hours / 24)} d`;
}

/** The sync status's label and tooltip (PULL-9), or null before the vault has been looked at. Never "Up to date" (PULL-10). */
export function syncStatus(state: SyncState, now: number): { kind: string; label: string; tooltip: string } | null {
	if (state.origin === false || state.vault?.kind === "no-origin") {
		return { kind: "no-remote", label: "No remote", tooltip: "This vault has no remote, so its notes are never pulled. Click to add one." };
	}
	if (state.running) return { kind: "pulling", label: "Pulling…", tooltip: "Pulling new revisions from the remote." };
	const vault = state.vault;
	if (!vault) {
		if (state.origin !== true) return null;
		return { kind: "not-pulled", label: "Not pulled yet", tooltip: "The vault hasn't pulled since Obsidian opened. Click to pull." };
	}
	const ago = state.lastSynced === null ? "never" : `${duration(now - state.lastSynced)} ago`;
	switch (vault.kind) {
		case "synced":
		case "pulled": {
			const notPushed = vault.ahead > 0 ? ` · ${vault.ahead} not pushed` : "";
			return { kind: "synced", label: `Synced ${ago}${notPushed}`, tooltip: "The vault has every revision on the remote. Click to pull." };
		}
		case "waiting":
			return {
				kind: "waiting",
				label: `${vault.count} waiting`,
				tooltip: `New revisions on the remote change files you haven't committed: ${vault.files.join(", ")}`,
			};
		case "diverged":
			return {
				kind: "diverged",
				label: "Sync needed",
				tooltip: "Your revisions and the remote's both moved. Pull with rebase in git, then pull again.",
			};
		case "offline":
			return { kind: "offline", label: state.lastSynced === null ? "Offline" : `Offline, ${ago}`, tooltip: vault.message };
	}
}

/** What the sync menu shows (PULL-19 to PULL-21). */
export interface SyncMenu {
	/** Information lines, which can't be clicked. */
	lines: string[];
	/** Pull now's label, and whether it can be clicked. Null without a remote. */
	pull: { label: string; enabled: boolean } | null;
	/** The item that opens the settings. */
	settings: "Pull settings…" | "Add a remote…";
}

export function syncMenu(state: SyncState, now: number): SyncMenu {
	if (state.origin === false || state.vault?.kind === "no-origin") {
		return { lines: ["This vault has no remote."], pull: null, settings: "Add a remote…" };
	}
	const checked = state.lastSynced === null ? "Not checked yet" : `Checked the remote ${duration(now - state.lastSynced)} ago`;
	const last = state.lastPulled;
	const pulled =
		last === null
			? "Nothing pulled since Obsidian opened"
			: `Last pulled ${last.count} ${last.count === 1 ? "revision" : "revisions"} ${duration(now - last.at)} ago`;
	return {
		lines: [checked, pulled],
		pull: state.running ? { label: "Pulling…", enabled: false } : { label: "Pull now", enabled: true },
		settings: "Pull settings…",
	};
}

export type PullReason = "launch" | "focus" | "timer" | "now" | "compile";

export interface PullOutcome {
	/** Null when the vault isn't set up. */
	vault: VaultPull | null;
	repos: RepoPull[];
}

export interface PullerOptions {
	/** The vault's path, or null when it isn't set up. */
	vaultPath: () => string | null;
	projectFolder: () => string;
	/** Pull automatically (CFG-25). */
	automatic: () => boolean;
	/** Also pull code repositories (CFG-27). */
	pullCode: () => boolean;
	ownEmail: () => Promise<string>;
	compiling: () => boolean;
	/** Called when the sync status may have changed. */
	changed: () => void;
	/** Called after every pull that ran. */
	pulled: (outcome: PullOutcome, reason: PullReason) => void | Promise<void>;
	now?: () => number;
}

const AUTOMATIC: PullReason[] = ["launch", "focus", "timer"];

/**
 * Runs the pulls: one at a time, never while a compile runs (a pull that falls due then waits for it to end),
 * a focus pull at most every 30 seconds, and automatic pulls only when they are on.
 */
export class Puller {
	state: SyncState = { running: false, origin: null, vault: null, lastSynced: null, lastPulled: null };
	private running: Promise<PullOutcome> | null = null;
	private lastPull: number | null = null;
	private deferred: PullReason | null = null;

	constructor(private options: PullerOptions) {}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	/** Resolves to what the pull did, or null when it was skipped or waits for the compile. */
	async pull(reason: PullReason): Promise<PullOutcome | null> {
		if (AUTOMATIC.includes(reason) && !this.options.automatic()) return null;
		if (reason !== "compile" && this.options.compiling()) {
			// "Pull now" outranks an automatic pull that is already waiting.
			if (this.deferred === null || reason === "now") this.deferred = reason;
			return null;
		}
		if (reason === "focus" && this.lastPull !== null && this.now() - this.lastPull < FOCUS_PULL_GAP_MS) return null;
		if (this.running) {
			if (reason !== "compile" && reason !== "now") return this.running;
			// The compile and Pull now need a pull that started after they asked.
			await this.running.catch(() => {});
			return this.pull(reason);
		}
		this.running = this.run(reason).finally(() => {
			this.lastPull = this.now();
			this.running = null;
		});
		return this.running;
	}

	/** Runs the pull that fell due during the compile, if any. */
	compileEnded(): Promise<PullOutcome | null> {
		const reason = this.deferred;
		this.deferred = null;
		return reason ? this.pull(reason === "focus" ? "timer" : reason) : Promise.resolve(null);
	}

	/** Looks again whether the vault has an `origin`, e.g. on launch or after the remote is saved. Never fetches. */
	async checkOrigin() {
		const vaultPath = this.options.vaultPath();
		const origin = vaultPath ? await hasOrigin(vaultPath) : null;
		if (origin === this.state.origin) return;
		this.state.origin = origin;
		// A vault that just got a remote hasn't pulled from it yet.
		if (origin && this.state.vault?.kind === "no-origin") this.state.vault = null;
		this.options.changed();
	}

	private async run(reason: PullReason): Promise<PullOutcome> {
		const vaultPath = this.options.vaultPath();
		this.state.origin = vaultPath ? await hasOrigin(vaultPath) : null;
		if (this.state.origin) {
			this.state.running = true;
			this.options.changed();
		}
		let vault: VaultPull | null = null;
		let repos: RepoPull[] = [];
		try {
			if (vaultPath) {
				vault = await pullVault(vaultPath, await this.options.ownEmail()).catch(
					(error): VaultPull => ({ kind: "offline", message: gitError(error) }),
				);
			}
			if (this.options.pullCode()) repos = await pullRepos(projectRepos(this.options.projectFolder())).catch(() => []);
		} finally {
			this.state.running = false;
		}
		if (vault) {
			this.state.vault = vault;
			if (vault.kind !== "offline" && vault.kind !== "no-origin") this.state.lastSynced = this.now();
			if (vault.kind === "pulled") this.state.lastPulled = { at: this.now(), count: vault.count };
		}
		this.options.changed();
		const outcome = { vault, repos };
		await this.options.pulled(outcome, reason);
		return outcome;
	}

	/** Recounts the vault's revisions not pushed, after a commit. Never fetches. */
	async recount() {
		const vaultPath = this.options.vaultPath();
		const vault = this.state.vault;
		if (!vaultPath || (vault?.kind !== "synced" && vault?.kind !== "pulled")) return;
		const ahead = await aheadOfOrigin(vaultPath).catch(() => vault.ahead);
		if (ahead === vault.ahead) return;
		this.state.vault = { kind: "synced", ahead };
		this.options.changed();
	}
}
