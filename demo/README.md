# Demo: Pocket Board, built by the goal loop

This demo builds **Pocket Board** ([GOAL.md](GOAL.md)), a small browser task board in TypeScript, from an empty GitHub repository. The work runs in GitHub Copilot: the Orchestrator agent in VS Code's Agents window, on a standalone agent host kept alive by copilot-forever. Expected loop time: about 3 to 5 hours for 8 to 10 issues. The demo is designed to be recorded; [VIDEO-OUTLINE.md](VIDEO-OUTLINE.md) is the shot list.

The demo config ([goal-loop.config.json](goal-loop.config.json)) differs from the kit's defaults in three ways, all chosen for the video:

| Setting | Demo | Default | Why |
|---|---|---|---|
| `github.mergePolicy` | `agent-after-green` | `human` | The loop merges its own PRs after green CI and a matching gate receipt, so it can run unattended. It still never pushes to the default branch and never uses auto-merge. |
| `keepAlive.port` | `47811` | `47801` | Leaves 47801 free for any agent host you already run. |
| `keepAlive.thresholdMiB` | `25` | `400` | A log trim happens within the recording instead of after days. |

## What you need

- A machine with Node 22 or newer, Git, the GitHub CLI (`gh`, logged in), VS Code stable with the `code` command on PATH, and GitHub Copilot with access to the models in the demo config.
- A GitHub account where you can create a repository. The steps use `pocket-board` as the name.
- Optional: the Copilot CLI, for the version check.

## Steps

All commands run in an ordinary terminal (PowerShell on Windows, a shell on macOS or Linux), in your projects folder.

**1. Get the kit** (or skip this if you already have it):

```bash
git clone https://github.com/seangalliher/copilot-forever.git
```

**2. Create the demo repository** with one initial commit (the gate needs a commit to test):

```bash
gh repo create pocket-board --public --add-readme --license mit --clone
```

**3. Bootstrap it with the demo config.** This installs copilot-forever (`npm ci`, `npm link`) and writes the agents, standing orders, gate script and handoff template into the repo:

```bash
node copilot-forever/bootstrap.mjs --repo pocket-board --config copilot-forever/demo/goal-loop.config.json
```

**4. Put the goal in place:**

```bash
cp copilot-forever/demo/GOAL.md pocket-board/.goal-loop/GOAL.md
```

**5. Commit the scaffolding** to the default branch yourself. The loop itself never pushes to the default branch.

```bash
cd pocket-board
```

```bash
git add .github/agents .github/copilot-instructions.md .goal-loop
```

```bash
git commit -m "Add goal-loop agents and goal" && git push
```

**6. Start the keep-alive layer:**

```bash
copilot-forever doctor --config .goal-loop/copilot-forever.config.json
```

```bash
copilot-forever install --config .goal-loop/copilot-forever.config.json
```

```bash
copilot-forever host start --config .goal-loop/copilot-forever.config.json
```

**7. Connect VS Code.** Add the standalone host to the `chat.remoteAgentHosts` user setting with address `localhost:47811` and the token from `~/.copilot-forever/token.txt`. Reload the window.

**8. Start the loop.** In the Agents window, start a new session on that host, choose the `pocket-board` folder and the **Orchestrator** agent, and send:

```text
start
```

**9. Approve the plan.** The Architect writes `.goal-loop/PLAN.md` and the Orchestrator shows you the issues. Read them. Ask for changes if you want any, then reply:

```text
APPROVE PLAN
```

The issues appear in the repository with the `goal-loop` label, and the loop begins.

**10. Let it run.** You can close VS Code at any time; the session keeps working. To watch, open the repository's Pull requests and Issues pages, or `.goal-loop/handoff.md`. To stop it at the next step, create the file `.goal-loop/STOP`; delete it and send `resume` to continue.

## What to expect

- One PR per batch (one to three coupled issues), each with the review rounds, the gate receipt summary and `Closes #…` lines.
- Diff Reviewer findings fixed before each commit. An issue still not converged after review round 3 is parked with the `goal-loop:needs-human` label and a comment; the loop continues with other work.
- A log trim when the session log passes 25 MiB and a compaction has happened: the agent stops at a safe point, the watcher trims and restarts the host, and the agent continues on its own. To trigger one on camera, lower `trim.thresholdMiB` in `.goal-loop/copilot-forever.config.json` below the current size (`copilot-forever host status` shows it). The agent picks it up at its next safe point, within about 10 minutes.
- At the end, a final addendum in `.goal-loop/handoff.md` with what was built, the PRs, the receipts and the time taken.

## Afterwards

```bash
npm ci && npm run dev
```

To remove the keep-alive schedule (the session's host keeps running until you stop it):

```bash
copilot-forever uninstall --stop-host --config .goal-loop/copilot-forever.config.json
```

## If something goes wrong

- **The plan or an issue is not what you want:** reply in the chat; the Orchestrator sends changes to the Architect. Before approval nothing is filed.
- **A notification says "resume needed":** open the session and send `continue from the latest handoff addendum`.
- **An issue is parked (`goal-loop:needs-human`):** read its last comment, decide, comment your decision on the issue, and tell the Orchestrator.
- **Logs:** `~/.copilot-forever/logs/copilot-forever.log` (watcher, trims, continues) and `.goal-loop/receipts/` (gates).
