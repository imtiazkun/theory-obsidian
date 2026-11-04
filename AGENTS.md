# AGENTS.md

theory.md is a desktop-only Obsidian plugin written in TypeScript. Read `CLAUDE.md` for the architecture and the invariants, and `WORKFLOW.md` before changing the compile pipeline.

## Commands

```bash
npm install
npm run build   # tsc type-check, then esbuild bundle into dist/
npm test        # Vitest, every test once
npm test -- test/branches.test.ts             # one test file
npm test -- test/branches.test.ts -t "reuses" # one test, by name
```

Before every commit run `npm run build` and `npm test`. Both must pass. Never commit past a failing test.

## Tests

- Tests live in `test/*.test.ts` and use Vitest.
- Every change to branch, commit, compile or anchor logic comes with a test that would have failed before the change.
- Tests that need git use real repositories in a new temporary folder (`tempFolder()` and `initRepo()` in `test/helpers.ts`), deleted after each test. They never touch the vault, the project folder or your own repositories.
- Tests never call Claude Code, GitHub or the network. `test/setup.ts` puts failing fakes of `claude` and `gh` first on PATH. ACP tests run a small fake agent made in the test's temp folder, never a real one.
- The `obsidian` module is replaced by the stub in `test/obsidian.ts`. Views, modals and the file explorer are checked by hand in Obsidian.
