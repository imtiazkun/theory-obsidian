import { hasOrigin } from "./github";
import { NO_PROMPT_ENV } from "./pull";
import { git } from "./vault";

/** How a push of the vault's `main` ended (CMT-30 to CMT-36). */
export type PushResult =
	| { kind: "pushed" }
	/** The vault has no `origin`, so nothing was pushed (CMT-36). */
	| { kind: "no-origin" }
	/** The remote has revisions the vault doesn't (CMT-35). */
	| { kind: "rejected" }
	| { kind: "failed"; message: string };

/** What CMT-35 tells the engineer to do when the remote moved. */
export const PUSH_REJECTED = "the remote has new revisions. Pull with rebase in git, then push.";

function gitError(error: unknown): string {
	return (error as { stderr?: string }).stderr?.trim() || (error instanceof Error ? error.message : String(error));
}

/**
 * Pushes the vault's `main` to `origin`, with every revision that isn't pushed yet (CMT-37). Never forces
 * and never pushes tags, so the last compile marker stays on this machine (CMT-32). Never waits for a
 * password or passphrase: git's prompts are off, so it fails instead (CMT-33).
 */
export async function pushVault(vaultPath: string): Promise<PushResult> {
	if (!(await hasOrigin(vaultPath))) return { kind: "no-origin" };
	try {
		await git(vaultPath, ["push", "--quiet", "--no-tags", "--no-follow-tags", "origin", "refs/heads/main:refs/heads/main"], NO_PROMPT_ENV);
		return { kind: "pushed" };
	} catch (error) {
		const message = gitError(error);
		if (/\[rejected\]|non-fast-forward|fetch first/i.test(message)) return { kind: "rejected" };
		return { kind: "failed", message };
	}
}

/** The notice after a commit and its push (CMT-13, CMT-34 to CMT-36). */
export function commitNotice(hash: string, push: PushResult): string {
	switch (push.kind) {
		case "pushed":
			return `Committed and pushed ${hash}`;
		case "no-origin":
			return `Committed ${hash}`;
		case "rejected":
			return `Committed ${hash}, but couldn't push: ${PUSH_REJECTED}`;
		case "failed":
			return `Committed ${hash}, but couldn't push: ${push.message}`;
	}
}

/** The notice after Push now in the sync menu (PULL-19), which pushes as a commit does. */
export function pushNotice(push: PushResult): string {
	switch (push.kind) {
		case "pushed":
			return "Pushed every revision to the remote.";
		case "no-origin":
			return "This vault has no remote.";
		case "rejected":
			return `Couldn't push: ${PUSH_REJECTED}`;
		case "failed":
			return `Couldn't push: ${push.message}`;
	}
}
