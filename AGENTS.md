# AGENTS.md

The theoretical model in the theory vault, folder obsidian-plugin/, is the source of truth for this repository. Its `instructions.md` there wins over this file.

Stack: TypeScript, Obsidian plugin API, esbuild, Vitest.

## Commands

- Install: `npm install`
- Build: `npm run build` (tsc type-check, then the esbuild bundle into `dist/`)
- Test: `npm test` (the whole Vitest suite, once)
- One test file: `npx vitest run test/branches.test.ts`
- One test by name: `npx vitest run -t "reuses the open compile branch"`

Before every commit, `npm run build` and `npm test` must both pass. Never commit past a failing test.

## Conventions

- Every change to branch, commit, compile or anchor logic comes with a test that would have failed before the change.
- Tests that need git use real repositories in a new temporary folder (`tempDir()` and `repo()` in `test/helpers.ts`), deleted afterwards. They never touch the vault, the project folder or real repositories.
- Tests never call Claude Code, GitHub or the network: mock `src/github.ts` with `vi.mock`, or pass a fake `claude` script as the command.
- `obsidian` is replaced by `test/obsidian-stub.ts`. Views, modals and the file explorer are checked by a person in Obsidian, so keep logic that needs testing out of the view files.
- See `CLAUDE.md` for the architecture and the invariants not to break.
