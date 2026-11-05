export interface StarterFile {
	/** Path relative to the vault root. */
	path: string;
	/** Paths relative to the vault root that count as this file, compared without case. */
	sameAs: string[];
	content: string;
}

const INSTRUCTIONS = `Theoretical model is the textual representation of a software: what it does, why and in some cases how. It should be detailed enough that an AI can replicate a whole software following this and easy enough so that a new recruit can understand.

## Human Only
- Only humans write the model. AI may read it, but must never create, edit, move or delete anything in it.
- The model is the source of truth. When the code disagrees with the model, the code changes.
- If the model is unclear or contradicts itself, AI asks a question in the compile report. It never guesses, and never suggests new wording.

## Doctrine
- Use AI for ideation but always **write by hand.** The words should be yours.
- **Make important statements crude**. "A refund is reject after 30 days", not 'refunds are handled carefully'
- **One claim per sentence.** A failed compile can then point at exactly one claim.
- **Use firm words.** *Must*, *never* and *always* for rules, *may* for options. Avoid *should* and *usually*.
- **Say why.** A rule without a reason gets "improved" away.
- **Say what the system must not do.** Behaviour the model doesn't describe shouldn't exist in the code.
- **Keep headings stable and give rules IDs** (\`INV-3\`, \`AC-7\`). Failure pointers anchor to them. Retire an ID; never reuse it.
- **Mark what isn't built yet**.
- **Answer Claude's questions in the model**, not in chat.
- **One intent per commit**, and the commit message says why.
`;

/** The first line of every model folder's instructions.md, and the starter text of its template. */
export const MODEL_INSTRUCTIONS =
	"The writing rules in [the root Instructions](../Instructions.md) apply here. Rules for Claude that apply only to this repository go below.\n";

/** The starter text of `_templates/index.md`. */
const INDEX_TEMPLATE = `## What this repository is

{{description}}

{{purpose}}

## Its place in the system

%% What it depends on, and what depends on it. Link the other repositories' index notes. %%

## What it does not do

%% What people might expect here but lives elsewhere, or nowhere. %%

## Notes

%% One line per note: the question it answers and its rule prefix. Concepts first, then the main flows, then UI and settings. %%

## Not built yet

%% The notes marked realized: false. %%
`;

export const INDEX_TEMPLATE_PATH = "_templates/index.md";
export const INSTRUCTIONS_TEMPLATE_PATH = "_templates/instructions.md";

/**
 * Everything Setup vault writes, besides the `.gitignore` lines. Setup and Create missing files
 * both use this one list, and skip any file that already exists under one of its names.
 */
export function starterFiles(vaultName: string): StarterFile[] {
	return [
		{ path: "Index.md", sameAs: ["Index.md"], content: `Manifesting ${vaultName}\n` },
		{ path: "Instructions.md", sameAs: ["Instructions.md", "instruction.md"], content: INSTRUCTIONS },
		{ path: INDEX_TEMPLATE_PATH, sameAs: [INDEX_TEMPLATE_PATH], content: INDEX_TEMPLATE },
		{ path: INSTRUCTIONS_TEMPLATE_PATH, sameAs: [INSTRUCTIONS_TEMPLATE_PATH], content: MODEL_INSTRUCTIONS },
	];
}

/** Where Setup puts the welcome note (SET-16). Not a starter file: once deleted, it stays deleted (SET-18). */
export const WELCOME_PATH = "_welcome.md";

/** The welcome note's text (SET-19). Owned by the code: compile must not change it. */
export const WELCOME_TEXT = `# Welcome to theory.md

This vault is your model. Its notes say what your software does and why, and the agent builds the code from them. Only people write here. Read \`Instructions.md\` before you start: it has the rules for writing the model.

## You already have a project
1. Go to Settings → theory.md and set **Project folder** to the folder that holds your repositories. Choose your **Agent** there too.
2. Make a model folder for each repository, with the same name as the repository. Open the **Repositories** page from the ribbon to see them.
3. Open a repository's \`index.md\` and click **Expand**. The agent lists the notes that are missing. Write them yourself.
4. Click **Commit**, then **Compile**. Answer the report's questions by editing your notes, then compile again.

### Too big to write by hand?
If there's too much code to describe from scratch, let the agent draft the theory for you. Treat the draft as raw material, not as the model.

Give the agent this prompt. Replace VAULT with your vault's folder and REPOSITORY with the repository's folder.

> Read \`VAULT/Instructions.md\` and \`VAULT/_templates/index.md\`. From the code in \`REPOSITORY\`, draft the theory of one feature into \`VAULT/_drafts/\`. Write one note per feature. Give every rule an ID made of a short prefix for the note and a number, like \`AUTH-1\`, \`AUTH-2\`. Each ID is used once in the whole vault. Write one claim per sentence, use *must*, *never* and *always*, and give the reason for each rule. Write only what the code shows. List anything unclear as a question at the end instead of guessing.

Then:
- Check every sentence against the code and delete anything you can't vouch for.
- Rewrite what's left into a model note in your own words, keeping the rule IDs.
- Commit only what you understand. The commit is signed with your name.

A folder whose name starts with \`_\`, like \`_drafts/\`, is never sent to the agent, so a draft can't change your code.

## You're starting a new project
1. Make an empty project folder and set it as the **Project folder** in Settings.
2. Describe the whole system in \`Index.md\`.
3. Add a model folder for each repository you plan to have, and write its notes. Untick **realized** on any note that isn't ready to build.
4. Click **Commit**, then **Compile**. The agent writes the code to match.

When you've read this, delete it. Its name starts with \`_\`, so it is never sent to the agent.
`;
