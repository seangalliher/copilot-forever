# Video outline: "An AI dev team that runs for days, entirely in GitHub Copilot"

A walkthrough of copilot-forever and the goal loop, built around one real run of the [Pocket Board demo](README.md). Target length: 18 to 22 minutes. Presenter: Sean Galliher.

**Before recording.** Do the run first and capture as you go; most segments are edited from that footage. Use a clean machine or a fresh user account for segment 3. Use a 1080p or larger screen, VS Code zoomed one or two steps, a dark theme, and notifications visible. Keep a stopwatch or the system clock in a corner of the screen for the long-running segments. Hide the token: never show `~/.copilot-forever/token.txt`, the settings value that holds it, or a terminal that prints it.

Legend: 🎥 = capture on screen, 🗣 = talking point, ⏱ = approximate segment length.

---

## 1. Cold open (⏱ 0:30)

🎥 Time-lapse of the finished run: the Issues page filling with closed issues, PRs merging one after another, ending on Pocket Board in the browser, cards being dragged, dark mode toggled.

🗣 "I gave GitHub Copilot one goal and approved one plan. It filed the issues, built them, reviewed its own work with a second model, tested, opened PRs, and kept going for hours, even when I quit VS Code. Here is how."

## 2. The problem (⏱ 2:00)

🗣 Two things stop a long-running agent session today:
- **The editor owns the session.** VS Code's built-in agent host runs the agent as a child of the editor process. Quit VS Code to update it, or because the window has grown to several GB, and the session dies.
- **The session's log only grows.** Copilot appends every event to `events.jsonl`, about 10 MB an hour for a busy agent. Big logs break resume: show the titles of github/copilot-cli #4325, #4664 and #2609 on screen.

🎥 VS Code Task Manager or Activity Monitor showing the agent runtime under the editor process. Then an `events.jsonl` file listing with its size.

🗣 "Most loop tools avoid this by starting a fresh `copilot -p` every iteration (Ralph loops). That works when each step can start cold. I wanted one session that keeps its context and that I can still talk to."

## 3. Architecture (⏱ 2:30)

🎥 The mermaid diagram from the top-level README, built up piece by piece (animate or reveal in steps):
1. **Keep-alive layer (copilot-forever):** standalone `code agent host` on localhost, started at logon; VS Code attaches to it instead of owning it.
2. **Watcher:** every 10 minutes, writes the log size; when the agent asks at a safe point, it stops the host, trims the log to the latest compaction, restarts it, and sends "Continue" over the Agent Host Protocol.
3. **Goal loop:** four Copilot custom agents: Orchestrator, Architect, Builder, Diff Reviewer. Plus a gate script and a handoff file.

🗣 The safety story in one breath: plan approval before anything is filed; PRs, never pushes to the default branch; a reviewer on a different model family; one test gate per batch with a receipt bound to the commit; caps; a STOP file.

## 4. Setup on a clean machine (⏱ 2:30)

🎥 Terminal, clean user account. Run demo steps 1 to 6 from [README.md](README.md): clone, `gh repo create`, `bootstrap.mjs`, copy the goal, commit, `doctor`, `install`, `host start`. Let the bootstrap's output and its printed next steps be readable (pause or zoom on them).

🎥 Task Scheduler (or `launchctl list`, or `systemctl --user list-timers`) showing the two scheduled jobs.

🎥 VS Code settings: adding the remote agent host (blur the token value).

🗣 Point out what bootstrap did *not* do: it pushed nothing, created no labels, and installed no tasks until you ran `install`.

## 5. The agents (⏱ 2:00)

🎥 The four `.agent.md` files side by side, briefly. Highlight in each:
- Orchestrator: the "two checks" (STOP file, caps), `APPROVE PLAN`, "one PR per batch", "after round 3, park and escalate".
- Architect: acceptance criteria must be observable; verify-first prompts.
- Builder: focused tests only, no architectural decisions, never commits.
- Diff Reviewer: "does the next consumer accept this change?"; the `model:` line showing a different model family.

🎥 `.github/copilot-instructions.md`: the evidence standard, "never `git add -A`", the deletion check.

## 6. Goal → plan → approval → issues (⏱ 2:30)

🎥 Agents window: new session on the standalone host, Orchestrator selected, send `start`.

🎥 The Architect's plan appearing in the chat: the issue list with dependencies. Scroll `.goal-loop/PLAN.md`.

🎥 Type `APPROVE PLAN`. Cut to the GitHub Issues page: issues appearing with the `goal-loop` label, acceptance criteria as checklists, `Depends on #…` lines.

🗣 "This is the only approval it needs from me. Everything after this runs inside the caps in the config."

## 7. The loop running (⏱ 3:00)

🎥 One full batch, edited down:
- The Orchestrator picking a batch and delegating to the Builder (the delegation card with the model name).
- The Builder's report: files changed, focused test result.
- The Diff Reviewer's findings, with severity and evidence. Pick a run where round 1 found something real, if you have one.
- The repair round, then the delta re-review saying "ready".
- `node .goal-loop/gate.mjs --label batch-1` in the terminal pane: PASS, the receipt path. Open the receipt JSON (commit, tree, command, duration).
- The PR on GitHub: body with `Closes #…`, review rounds, receipt summary; CI green; merged.
- The closed issue.

🗣 Call out the batching: "These two issues touch the same module, so they go through one gate and one PR."

## 8. Quit VS Code mid-run (⏱ 1:30)

🎥 While the Builder is working: quit VS Code completely (File > Exit / Quit). Show it is gone from the taskbar or Dock. Keep the stopwatch visible.

🎥 A terminal: `copilot-forever host status --config .goal-loop/copilot-forever.config.json` showing the host and the session, the log size growing. Optionally `git log --oneline` on the branch moving.

🎥 Reopen VS Code a minute or two later: the session is still running, with no gap in its work.

## 9. A log trim and automatic resume (⏱ 2:00)

🎥 `.goal-loop/session-log-status.json` with `trim_due: true` (lower `trim.thresholdMiB` beforehand if needed; see the demo README).

🎥 The Orchestrator reaching a safe point: writing the handoff addendum, writing `trim-request.json`, stopping.

🎥 The watcher log (`~/.copilot-forever/logs/copilot-forever.log`) as it runs: idle checks, "stopping host", "archived full log", the trim line with sizes (for example `48.2 MiB -> 1.1 MiB`), "host listening", "continue try 1: ok".

🎥 The desktop notification: "Agent log trimmed and resumed".

🎥 The chat: the automatic "Continue." message and the Orchestrator picking up from its handoff, naming the exact next step.

🗣 What makes it safe: the trim only cuts at a compaction that succeeded, archives the full log first, refuses unknown log layouts, and never touches a running session.

## 10. The finished app (⏱ 1:30)

🎥 `npm ci && npm run dev`. Pocket Board in the browser: add cards, drag between columns, keyboard moves, search, dark mode, export and import. Then the repository: the closed issues, the merged PRs, green CI on the default branch.

🎥 The final handoff addendum: what was built, PRs, receipts, parked items.

## 11. What it cost and took (⏱ 1:00)

🎥 A simple table, filled in from the run:

| Measure | Value | Source |
|---|---|---|
| Wall-clock time, approve to done | | final handoff addendum |
| Issues closed / PRs merged | | `gh issue list --state closed`, `gh pr list --state merged` |
| Review rounds (total, max per issue) | | PR bodies |
| Findings fixed before commit | | PR bodies |
| Issues parked for a human | | `goal-loop:needs-human` label |
| VS Code restarts survived / log trims | | your notes, watcher log |
| Copilot premium requests used | | GitHub Copilot usage page (before and after) |
| Human input | 2 messages (`start`, `APPROVE PLAN`) | the chat |

🗣 Be honest about what went wrong in the run: a parked issue, a failed continue, a review round that went in circles. That is the credibility of the video.

## 12. Limits and close (⏱ 1:00)

🗣 From the README's limits section: `events.jsonl` is an internal format (the trim refuses when it changes); the Agent Host Protocol and the standalone host are new; one long session per repo; macOS and Linux are less tested than Windows. Sandbox the agent if it auto-approves tools.

🎥 The repository page (github.com/seangalliher/copilot-forever), the bootstrap one-liner on screen.

🗣 Call to action: try it on a small goal, open an issue with what broke, share what your loop built.

---

## Capture checklist

- [ ] Clean-machine setup, start to finish (segment 4)
- [ ] Plan in chat, `APPROVE PLAN`, issues appearing (6)
- [ ] One batch end to end, including a real review finding and its repair (7)
- [ ] Gate run and receipt JSON (7)
- [ ] PR body, CI green, merge, closed issue (7)
- [ ] VS Code quit and reopen with a visible clock (8)
- [ ] `trim_due: true`, the safe-point stop, the watcher log, the notification, the automatic continue (9)
- [ ] The finished app in the browser (10)
- [ ] Copilot usage before and after (11)
- [ ] Token never on screen
