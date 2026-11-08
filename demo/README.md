# Demo: LoopBoard, built by the goal loop

This demo builds **LoopBoard** ([GOAL.md](GOAL.md)), a local-first kanban board that runs in the browser, from an empty GitHub repository (`seangalliher/loopboard`). Everything runs in GitHub Copilot. Expected loop time: a few hours for about 10 to 12 issues. [VIDEO-SCRIPT.md](VIDEO-SCRIPT.md) is the video built around this run.

Models ([goal-loop.config.json](goal-loop.config.json)): `claude-sonnet-5.5` for the Orchestrator, Architect and Builder; `gpt-6.1-sol` for the Diff Reviewer (fallback `gpt-6-luna`, also not the builder's family).

The same goal runs in either mode. Steps 1 to 7 are shared; then follow **A** (persistent session, the one in the video) or **B** (Ralph loop). To show both, use two repositories, for example `loopboard` and `loopboard-ralph`.

The demo config differs from the kit's defaults in three ways, all for the video:

| Setting | Demo | Default | Why |
|---|---|---|---|
| `github.mergePolicy` | `agent-after-green` | `human` | The loop merges its own PRs after green CI and a matching gate receipt, so it can run unattended. It still never pushes to the default branch and never uses auto-merge. |
| `keepAlive.port` | `47811` | `47801` | Leaves 47801 free for an agent host you already run. |
| `keepAlive.thresholdMiB` | `25` | `400` | A log trim happens within the recording. It becomes `trim.thresholdMiB` in `loopboard/.goal-loop/copilot-forever.config.json`; set it back to `400` there after recording. |

## What you need

- Node 22 or newer, Git, the GitHub CLI (`gh`, logged in with `gh auth login`), VS Code stable with the `code` command on PATH, and GitHub Copilot with access to the two models.
- For mode B: the Copilot CLI (`copilot`, logged in).

All commands run in an ordinary terminal (PowerShell on Windows, a shell on macOS or Linux), in your projects folder.

## Shared steps

**1. Install the kit:**

```bash
npm install -g copilot-forever
```

**2. Create the demo repository** with one initial commit (the gate needs a commit to test), and go into it:

```bash
gh repo create loopboard --public --add-readme --license mit --clone
```

```bash
cd loopboard
```

**3. Get the demo config and the goal.** Setup uses a `.goal-loop/config.json` that is already there, and keeps an existing `GOAL.md`. On Windows, type `curl.exe`, not `curl`: Windows PowerShell treats `curl` as a different command.

```bash
curl --create-dirs -o .goal-loop/config.json https://raw.githubusercontent.com/seangalliher/copilot-forever/main/demo/goal-loop.config.json
```

```bash
curl -o .goal-loop/GOAL.md https://raw.githubusercontent.com/seangalliher/copilot-forever/main/demo/GOAL.md
```

**4. Set it up.** Setup checks the tools, and says how to fix any that are missing. It then writes the four agents, the standing orders, the gate script and the handoff template into the repository. For mode A, add `--start`: it also schedules the watcher every 10 minutes and starts the standalone agent host. Leave it out for mode B.

```bash
copilot-forever setup --start
```

Then check the models in `.github/agents/*.agent.md` (the `model:` lines). In mode A you can paste the goal into the chat instead of downloading it; the Orchestrator saves it to `.goal-loop/GOAL.md`.

**5. Commit the scaffolding** to the default branch yourself, and push it:

```bash
git add .github/agents .github/copilot-instructions.md .goal-loop
```

```bash
git commit -m "Add goal-loop agents and goal" && git push
```

**6. Protect `main`.** From now on, GitHub requires a pull request for every change to `main`, admins included. The agents push as you, so this is what stops one pushing straight to it. A public repository gets this on GitHub's free plan.

```bash
copilot-forever protect
```

**7. Let GitHub Pages deploy from Actions.** The goal deploys to Pages, and changing repository settings is yours to do, not the agents':

```bash
gh api -X POST repos/seangalliher/loopboard/pages -f build_type=workflow
```

## A. Persistent session (VS Code)

**A1. Connect VS Code.** Add the standalone host to the `chat.remoteAgentHosts` user setting with address `localhost:47811` and the token from `~/.copilot-forever/token.txt`, as setup printed. Reload the window. To check the host: `copilot-forever host status --config .goal-loop/copilot-forever.config.json`.

**A2. Start the loop.** In the Agents window, start a new session on **that** host (not VS Code's built-in one), choose the `loopboard` folder and the **Goal Orchestrator** agent, set the effort in the model picker to **High**, and send:

```text
start
```

**A3. Approve the plan.** The Architect writes `.goal-loop/PLAN.md` and the Orchestrator shows you the issues. Ask for changes if you want any; when it is right, reply exactly:

```text
APPROVE PLAN
```

The issues appear with the `goal-loop` label and the loop begins. You can quit VS Code at any time; the session keeps working. To stop at the next step, create `.goal-loop/STOP`; delete it and send `resume` to continue.

**What you will see**

- One PR per batch (one to three coupled issues), each with the review rounds, the gate receipt summary and `Closes #…` lines, merged after CI is green.
- Diff Reviewer findings fixed before each commit. An issue not converged after review round 3 is parked with `goal-loop:needs-human` and a comment; the loop continues with other work.
- A log trim once the session log passes 25 MiB **and** a compaction has completed: the Orchestrator writes a handoff addendum and stops at a safe point; within about 10 minutes the watcher stops the host, trims, restarts it and sends "Continue."; a notification says *Agent log trimmed and resumed (X -> Y MiB)*. The watcher's log is `~/.copilot-forever/logs/copilot-forever.log`. If no compaction has happened yet, the trim is refused, the agent is told to continue, and it asks again later.
- At the end, a final addendum in `.goal-loop/handoff.md` with what was built, the PRs, receipts and time taken.

## B. Ralph loop (`copilot -p`, no VS Code needed)

Run it in a sandbox (a dev container, VM or dedicated account): each run uses `--allow-all-tools`. See [Permissions](../templates/goal-loop/README.md#permissions-read-this-before-the-first-run).

**B1. Preview the first run** (writes nothing, runs nothing):

```bash
copilot-forever loop --mode ralph --repo . --dry-run
```

**B2. Plan.** The first run has the Architect write `.goal-loop/PLAN.md`, then the runner stops:

```bash
copilot-forever loop --mode ralph --repo .
```

**B3. Approve the plan** after reading `.goal-loop/PLAN.md` (the approval is tied to the plan's exact content):

```bash
copilot-forever loop approve-plan --repo .
```

**B4. Run the loop.** The next runs file the issues, then do one batch per run, until the queue is done, `.goal-loop/STOP` exists, a cap is hit, or three runs in a row make no progress:

```bash
copilot-forever loop --mode ralph --repo .
```

Each run is logged to `.goal-loop/ralph/runs.jsonl` (step, start, end, exit code, issues and PRs touched), with its output, usage and transcript next to it.

## Afterwards

```bash
npm ci && npm run dev
```

The live board is at `https://seangalliher.github.io/loopboard/` once the Pages workflow has run on `main`.

Where the time went (mode A: the one session; mode B: pass one run's session with `--session`):

```bash
copilot-forever report --config .goal-loop/copilot-forever.config.json --out timing.md
```

Mode A cleanup: put `trim.thresholdMiB` back to `400`, or remove the schedule and stop the host:

```bash
copilot-forever uninstall --stop-host --config .goal-loop/copilot-forever.config.json
```

## If something goes wrong

- **The plan is not what you want:** mode A, reply in the chat; mode B, edit `GOAL.md`, delete `PLAN.md` and run the loop again. Nothing is filed before approval.
- **A notification says "resume needed"** (mode A): open the session and send `continue from the latest handoff addendum`.
- **The network dropped** (mode A): nothing to do. When the model API answers again, the watcher sends a continue and a notification says *Agent resumed after a network error*. After repeated failures it stops trying and a notification asks you to send `continue` yourself.
- **An issue is parked (`goal-loop:needs-human`):** read its last comment, decide, comment your decision on the issue, remove the label, and tell the Orchestrator (mode A) or run the loop again (mode B).
- **Mode B stopped with "stalled":** read the last entries of `.goal-loop/ralph/runs.jsonl` and the run's transcript; usually a batch waits on something only you can do.
- **Logs:** `~/.copilot-forever/logs/` (mode A watcher and host), `.goal-loop/receipts/` (gates), `.goal-loop/ralph/` (mode B runs).
