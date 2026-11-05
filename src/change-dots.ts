import { COMPILED_TAG } from "./compile";
import { changedFiles, git, isInDotFolder } from "./vault";

/** Where a file stands: uncommitted (orange), waiting for a compile (accent colour), or both, shown orange (UI-24, UI-25). */
export type ChangeDot = "uncommitted" | "pending" | "both";

export const DOT_TOOLTIPS: Record<ChangeDot, string> = {
	uncommitted: "Uncommitted changes",
	pending: "Committed, waiting for a compile",
	both: "Uncommitted changes. Earlier changes are waiting for a compile.",
};

/** What the dots are worked out from, read from git each time and never stored (UI-29). */
export interface DotState {
	/** Files with uncommitted changes, new files included. */
	uncommitted: string[];
	/** Files git tracks. */
	tracked: string[];
	/** Files changed since the compile marker, or "all" when there is no marker yet. */
	pending: string[] | "all";
}

/**
 * True for files that are never sent to Claude, so never wait for a compile: hidden notes, files in
 * hidden folders, and the root Instructions (UI-27).
 */
export function neverWaitsForCompile(path: string): boolean {
	if (path.split("/").some((part) => part.startsWith("_"))) return true;
	return !path.includes("/") && ["instructions.md", "instruction.md"].includes(path.toLowerCase());
}

/**
 * The dot each file and folder shows. A folder shows a dot when any file inside it has one, at any
 * depth, with orange winning (UI-26). Files in dot folders never show one (UI-28).
 */
export function changeDots({ uncommitted, tracked, pending }: DotState): Map<string, ChangeDot> {
	const dirty = new Set(uncommitted.filter((path) => !isInDotFolder(path)));
	const isTracked = new Set(tracked);
	const waiting = new Set(
		(pending === "all" ? tracked : pending.filter((path) => isTracked.has(path))).filter(
			(path) => !isInDotFolder(path) && !neverWaitsForCompile(path),
		),
	);

	const dots = new Map<string, ChangeDot>();
	const mark = (path: string, dot: ChangeDot) => {
		const current = dots.get(path);
		if (!current || current === dot) dots.set(path, dot);
		else dots.set(path, "both");
	};
	for (const path of new Set([...dirty, ...waiting])) {
		const dot: ChangeDot = dirty.has(path) ? (waiting.has(path) ? "both" : "uncommitted") : "pending";
		dots.set(path, dot);
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			const folder = parts.slice(0, i).join("/");
			if (dot === "both") dots.set(folder, "both");
			else mark(folder, dot);
		}
	}
	return dots;
}

/** Whether the dot shows orange: uncommitted wins over waiting for a compile (UI-25). */
export function isOrange(dot: ChangeDot): boolean {
	return dot !== "pending";
}

/** Reads the dots' state from git. */
export async function readDotState(vaultPath: string): Promise<DotState> {
	const uncommitted = await changedFiles(vaultPath);
	const { stdout: files } = await git(vaultPath, ["ls-files", "-z"]);
	const tracked = files.split("\0").filter(Boolean);
	try {
		const { stdout } = await git(vaultPath, ["diff", "--name-only", "-z", `refs/tags/${COMPILED_TAG}`, "HEAD"]);
		return { uncommitted, tracked, pending: stdout.split("\0").filter(Boolean) };
	} catch {
		// No compile marker yet (HDR-6).
		return { uncommitted, tracked, pending: "all" };
	}
}
