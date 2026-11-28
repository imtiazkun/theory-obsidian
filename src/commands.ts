// theory.md's commands (UI-10) and ribbon buttons (UI-8), as plain lists so the exact set can be tested.
// `TheoryPlugin.onload` registers exactly these, and nothing else.

import { REPOSITORIES_RIBBON_TITLE } from "./first-load";

/** The commands, in UI-10's order. There are no others. */
export const THEORY_COMMANDS = [
	{ id: "setup-vault", name: "Setup vault" },
	{ id: "show-commit-history", name: "Show commit history" },
	{ id: "compile", name: "Compile" },
	{ id: "build", name: "Build" },
	{ id: "show-compile-report", name: "Show compile report" },
	{ id: "commit-current-note", name: "Commit current note" },
	{ id: "show-repositories", name: "Show repositories" },
	{ id: "pull-now", name: "Pull now" },
	{ id: "comment-on-selection", name: "Comment on selection" },
	{ id: "show-comments", name: "Show comments" },
	{ id: "use-core-plugins", name: "Use theory.md's core plugins" },
	{ id: "new-repository", name: "New repository" },
] as const;

export type TheoryCommandId = (typeof THEORY_COMMANDS)[number]["id"];

/**
 * The left ribbon buttons theory.md adds: only Repositories (UI-8). There is no Compile button: a compile
 * starts from the floating bar, the command "Compile" or Recompile in a report (CMP-1).
 */
export const THEORY_RIBBON = [{ icon: "folder-git-2", title: REPOSITORIES_RIBBON_TITLE, command: "show-repositories" }] as const satisfies readonly {
	icon: string;
	title: string;
	command: TheoryCommandId;
}[];
