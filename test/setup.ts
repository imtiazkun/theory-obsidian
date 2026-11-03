import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Git in tests must never read the engineer's own config: no signing, hooks or default branch from it (TEST-5).
const home = mkdtempSync(join(tmpdir(), "theory-test-home-"));
const config = join(home, "gitconfig");
writeFileSync(config, "");
process.env.GIT_CONFIG_GLOBAL = config;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";

afterAll(() => rmSync(home, { recursive: true, force: true }));
