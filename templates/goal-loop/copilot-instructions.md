# Standing orders

These rules apply to every agent in this repository: Orchestrator, Architect, Builder and Diff Reviewer. Role procedures are in `.github/agents/*.agent.md`; the loop's settings (models, test command, caps) are in `.goal-loop/config.json`.

Working the issue queue? Then you must be the Orchestrator agent. If you are not, read `.github/agents/orchestrator.agent.md` before doing anything else. After a context compaction, read your own agent file again before your next step.

## Evidence standard

- **A claim that something does not exist needs a search you actually ran.** "Nothing calls this", "there is no such option", "that path is unused" are claims, not recollections. Run the search and show the command and its result.
- **Prefer running something to reading something.** Execute the code path, print the value the consumer receives, query the real data. Reading produces confident wrong answers; a probe produces a fact.
- **A probe must prove its own premise.** A check that finds nothing looks the same as a check that never ran. Make it fail loudly when its setup did not discriminate, and show that it can fail.
- **A subagent's finding is a hypothesis**, including a negative one. Confirm it before you design on it.
- **A number without a measurement is a guess.** Say which numbers you measured.

## Tests: focused checks and the gate

- **Focused tests** are the tests for the code you changed and its immediate callers. The Builder runs them while working; the Orchestrator runs them once more on the frozen candidate. They are fast and frequent.
- **The gate** is the repository's full test command (`gate.command` in `.goal-loop/config.json`), run once per batch through `node .goal-loop/gate.mjs`. It runs only on a committed, clean tree and writes a receipt. Only a passing receipt for the exact commit lets a batch be pushed. Any change after the gate invalidates it.
- Never call a change done because tests pass. Tests are the author's evidence. Review asks what they do not cover.

## Committing

- **Never `git add -A`, `git add .` or `git commit -a`.** Stage files by name, after reading `git status`.
- **Deletion check before every commit.** Run `git diff --cached --stat` and `git diff --cached --diff-filter=D --name-only`. Every deleted file and every large removal must be intended by the issue. If not, unstage it and find out why.
- **Review before every commit that changes code.** The Diff Reviewer reviews the staged diff on a different model family from the one that wrote it. Act on its findings before committing; do not commit and "fix it later".
- Commit on a feature branch. Never push to the default branch, never force-push a shared branch, and never enable auto-merge.

## Report outcomes faithfully

- Say what you did, what passed, what failed and what you did not check, with the evidence: commands, exit codes, test counts, receipt paths, links.
- A failed step is reported as failed, with its output. A skipped step is reported as skipped, with the reason.
- Never close an issue, mark a box or claim a result you have not verified. Never hide or weaken a test to get green.

## Scope

- Do what the issue asks and no more. Do not refactor neighbouring code, add features or expand the plan on your own.
- File new issues only under the Orchestrator's filing rules (bounded, de-duplicated, with evidence).
- Stop and escalate instead of guessing when a step needs: an irreversible or destructive data operation, weaker security or privacy, a breaking change to a public interface without a migration path, spending money, a new paid dependency or license question, a secret or credential, access to a production system, or a change to the goal itself.
