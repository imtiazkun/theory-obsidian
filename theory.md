# theory.md

## The problem

When AI writes the code, the bigger risk is no longer messy code. The bigger risk is that the team stops understanding what the system does and why. Margaret-Anne Storey calls this *cognitive debt*: technical debt lives in the code, while cognitive debt lives in developers' minds.

Peter Naur's *Programming as Theory Building* explains why this matters. A program is really a theory held in its developers' heads: what the system is, why it works the way it does, and how it should change. The code is only a by-product of that theory. When agents write the code and nobody holds the theory, the system becomes a black box.

## The idea

theory.md keeps the theory on the page, where the team can read it, review it and own it.

- **Humans write the theoretical model.** It's a set of notes saying what the software does, why, and in some cases how. It should be detailed enough for an AI to rebuild the whole software from it, and plain enough for a new recruit to understand.
- **AI builds the code from the model.** It reads the model and changes the code to match.
- **The AI never writes to the model.** The people who understand the system stay the source of truth.

## Philosophy

- **The model comes first.** The code follows the model, never the other way round. When they disagree, the code changes.
- **The model is human-only.** AI may help a person think, ask questions or point out gaps. The words in the model are always written by a person.
- **Every change has an author.** Each revision of the model is signed by the engineer who wrote it, so the history shows who holds which part of the theory.
- **Unclear means ask, not guess.** When the model is vague or contradicts itself, the AI asks a question and leaves that part alone. People answer by improving the model, so the answer is there for the next reader.
- **The model is closed.** Behaviour the model doesn't describe shouldn't exist in the code. Something new goes into the model first.
- **Failures point back to the theory.** When building fails, the app shows which part of the model it came from. Fixing it is a decision a person makes.
- **Writing ahead is allowed.** A note may describe something not yet built. It's marked as not realized, and the AI leaves it for later.

## How it works

1. **Set up.** An Obsidian vault becomes the model, in its own git repository, starting with an `Index.md` and an `Instructions.md` that holds the human-only rules and the writing doctrine.
2. **Write.** An engineer edits notes by hand.
3. **Commit.** Each change is recorded as a commit signed with the engineer's name and email.
4. **Compile.** Compile sends every revision committed since the last compile to Claude Code. Claude works in the project folder, which holds one repository or several. It changes the code to match the model.
5. **Report.** Claude returns a report with a summary, the changes it made, questions about the model, and problems. Engineers answer questions by editing the model and compiling again.

## The client

theory.md is an Obsidian plugin. Obsidian is where engineers write, read and look after the model.

**Why Obsidian.** The model is plain Markdown files in a folder, with SVG and images for diagrams. Obsidian edits those files as they are, links notes to each other, and keeps everything on the engineer's own machine. Nothing locks the model into one tool, and git can track every line.

**What the engineer sees:**

- **The model.** The vault opens on `Index.md`, the entry point to the theory. `Instructions.md` sits beside it with the rules for writing the model and for building from it.
- **Commit.** A button in each note's header records the note's changes as a signed commit. It's marked when the note has changes. A sidebar shows the note's history: who changed it, when, and why.
- **Compile.** A button at the bottom right of the editor shows how many revisions are waiting to be compiled. Clicking it hands them to Claude.
- **The compile report.** It opens in its own tab, showing what Claude did, the questions it has about the model and anything that went wrong. Each question links to the notes it's about.
- **Failure pointers.** When a compile fails, the notes it points to get a banner, and the exact sentence is highlighted. Clicking a problem in the report jumps to that spot.
- **Note status.** Two marks in each note's header. A check box the engineer ticks or unticks to say whether the note is realized, and an icon showing what compiling has done with the note: waiting, compiling, failed or compiled.
- **Hidden folders.** Folders starting with `_`, such as `_templates`, hold supporting material rather than the theory itself. They show in grey, below everything else.

**What the client never does.** It never lets the AI into the vault. Claude reads a read-only copy of the model. Reports, highlights and settings stay in the plugin's own data, never in the notes.

## Further reading

- Storey, M.-A. (2026, February 9). *How generative and agentic AI shift concern from technical debt to cognitive debt.* https://margaretstorey.com/blog/2026/02/09/cognitive-debt/
- Naur, P. (1985). Programming as theory building. *Microprocessing and Microprogramming, 15*(5), 253–261.
