import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll } from "vitest";

// Tests never reach Claude Code or GitHub: fake `claude` and `gh` come first on PATH and always fail.
// This runs before the tested modules load, so the plugin's TOOL_PATH starts with them too.
const fakes = mkdtempSync(join(tmpdir(), "theory-test-bin-"));
for (const tool of ["claude", "gh"]) {
	const path = join(fakes, tool);
	writeFileSync(path, `#!/bin/sh\necho "${tool} is faked in tests" >&2\nexit 1\n`);
	chmodSync(path, 0o755);
}
process.env.PATH = `${fakes}:${process.env.PATH}`;

// Git reads a test config instead of the engineer's own, so commits are signed by a test author
// unless the plugin passes its own.
const gitConfig = join(fakes, "gitconfig");
writeFileSync(gitConfig, "[user]\n\tname = Test Author\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n");
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";

afterAll(() => rmSync(fakes, { recursive: true, force: true }));
