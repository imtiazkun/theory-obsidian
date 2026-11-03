import { spawn } from "child_process";

/** How long the plugin waits for the login shell (CMP-46). A broken profile must never hang Obsidian. */
export const LOGIN_SHELL_TIMEOUT_MS = 5000;

const MARKER = "__THEORY_PATH__";

/** Folders always added after the PATH, so git and Claude Code are still found (CMP-47). */
export function extraFolders(home = process.env.HOME): string[] {
	return ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", home ? `${home}/.local/bin` : ""].filter(Boolean);
}

/** `base` followed by the extra folders. */
export function withExtraFolders(base: string | undefined, home = process.env.HOME): string {
	return [base, ...extraFolders(home)].filter(Boolean).join(":");
}

/** The shell named in `$SHELL`, or `/bin/zsh` when it isn't set (CMP-45). */
export function loginShell(env: NodeJS.ProcessEnv = process.env): string {
	return env.SHELL || "/bin/zsh";
}

/**
 * The PATH printed by `shell` run as a login, interactive shell, or undefined when the shell fails,
 * prints no PATH or takes longer than `timeoutMs`. Markers around the PATH skip whatever the
 * shell's startup files print.
 */
export function readLoginPath(shell: string, timeoutMs = LOGIN_SHELL_TIMEOUT_MS): Promise<string | undefined> {
	return new Promise((resolve) => {
		let done = false;
		let stdout = "";
		const finish = (path: string | undefined) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(path);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(shell, ["-ilc", `echo ${MARKER}; printenv PATH; echo ${MARKER}`], {
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			resolve(undefined);
			return;
		}
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(undefined);
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.on("error", () => finish(undefined));
		child.on("close", (code) => {
			if (code !== 0) return finish(undefined);
			const parts = stdout.split(MARKER);
			const path = parts.length >= 3 ? parts[1].trim() : "";
			finish(path || undefined);
		});
	});
}

/** The login PATH followed by the extra folders, or Obsidian's own PATH followed by them when the shell fails. */
export async function resolveToolPath(
	shell = loginShell(),
	timeoutMs = LOGIN_SHELL_TIMEOUT_MS,
	fallback = process.env.PATH,
): Promise<string> {
	return withExtraFolders((await readLoginPath(shell, timeoutMs)) ?? fallback);
}

let loaded: string | undefined;

/** Reads the login PATH once, when the plugin loads (CMP-45). */
export async function loadToolPath(): Promise<void> {
	loaded = await resolveToolPath();
}

/** The PATH every command the plugin runs gets (CMP-44). Before it's loaded, Obsidian's own PATH plus the extra folders. */
export function toolPath(): string {
	return loaded ?? withExtraFolders(process.env.PATH);
}
