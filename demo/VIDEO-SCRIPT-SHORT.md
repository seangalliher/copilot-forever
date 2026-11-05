# Short video: two takes, about 10 minutes of recording

The long version is [VIDEO-SCRIPT.md](VIDEO-SCRIPT.md). This one is for recording in two single takes and talking naturally. Talking points to glance at, not lines to read.

**Finished video:** 8–10 minutes = take 1 (~5 min) + time-lapse (60–90 s) + take 2 (~5 min).
**Record with:** Clipchamp's screen-and-camera recorder, or Snipping Tool's video mode. Camera in a corner if you like.

---

## Before take 1 (5 minutes of setup, off camera)

- [ ] `loopboard` repo created and cloned next to `copilot-forever`; Git, Node, `gh`, VS Code with Copilot, and the Copilot CLI installed.
- [ ] Notifications on (Windows: Focus off) so the trim toast shows.
- [ ] Close anything private: other browser tabs, email, chat. Never show the token file or `gh auth` output.
- [ ] Note your Copilot usage (AI credits) so you can say what the run cost.
- [ ] Start the time-lapse of the Agents window only: `pwsh demo/capture/timelapse.ps1 start -Window '^Agents$'` (one frame every 5 seconds; it keeps running when you stop recording, and nothing else on your screen is captured). Size the Agents window to 1920×1080 (a FancyZones zone works) *before* starting: the capture keeps the size the window had when it started, so after a resize, run stop and start again. Quitting VS Code stops the capture: run the same command again after you reopen it.

---

## Take 1: the setup and the goal (~5 minutes)

**1. Hook (30 s), on camera or over the empty repo**
- "I'm going to give GitHub Copilot one goal, approve one plan, and walk away. When I come back, it should have built and shipped an app."
- "It's a kanban board called LoopBoard. Copilot will plan it, file its own issues, write the code, get every change reviewed by a second AI model, and deploy it."

**2. Why this is hard (45 s)**
- One-shot AI coding: you're the loop.
- Two walls when one Copilot session runs for hours: closing VS Code kills it, and the session log grows until it slows down or fails to resume.
- "So I built two things: a team of agents, and a small kit that keeps the session alive."

**3. Setup (1 min)**
- Run the bootstrap: `node copilot-forever/bootstrap.mjs --repo loopboard --config copilot-forever/demo/goal-loop.config.json --start`
- Say what it did: copied four agents into my repo, started a standalone agent host that doesn't belong to VS Code, and scheduled a watcher.
- Open `.github/agents/`: Orchestrator, Architect, Builder, Diff Reviewer. "Sonnet 5.5 builds; GPT-6.1 Sol reviews. A different model family as a second opinion."
- Add the host to VS Code, as the bootstrap printed, and start a new session on that host in the `loopboard` folder with the **Goal Orchestrator** agent; set the effort in the model picker to High. Optional line: "The planner and the reviewer think at maximum effort; the builder and the coordinator at high. Judgement where it matters, speed where the spec carries it."

**4. The goal and the plan (2 min)**
- Paste the goal from `demo/GOAL.md`. "That's all I'm telling it."
- The plan comes back: read two or three items aloud.
- "It won't file anything until I approve. That's my one checkpoint." Type `APPROVE PLAN`.
- Switch to GitHub Issues as they appear. Open one: acceptance criteria, dependencies. "That's the queue."

**5. Close (15 s)**
- "Now I leave it. See you when it's done."

Stop recording. Leave the session and the time-lapse running.

---

## The middle (no recording by you)

The time-lapse runs. When the build is finished:
- [ ] `pwsh demo/capture/timelapse.ps1 stop`, then `pwsh demo/capture/timelapse.ps1 build -Seconds 75` makes the sped-up clip.
- [ ] `pwsh demo/capture/stats.ps1 -Repo seangalliher/loopboard` prints the numbers for take 2 and saves them to `stats.md`.
- [ ] `copilot-forever report --config .goal-loop/copilot-forever.config.json --out timing.md` (in `loopboard`) shows where the hours went: agents, the Orchestrator, waiting for a message, and every subagent run.
- [ ] Check how much your Copilot usage went up.

---

## Take 2: the result (~5 minutes)

**1. The app (1½ min)**
- Open LoopBoard on its GitHub Pages URL. Add a card, drag it, move one with the keyboard, hit a WIP limit, switch to dark mode, reload: it's still there.
- "I didn't write a line of this."

**2. How it got here (1½ min)**
- Read the real numbers from `stats.md`: issues, pull requests, review rounds and findings, gate runs, hours, cost.
- Show `timing.md`'s first table: how many hours the agents worked against the minutes it waited for a message (that row includes the watcher's continues, so check it before you say "for me"). "That's the trade: its hours, my minutes."
- Open one PR: the description, and one finding the reviewer caught. "This is the part that used to be me."
- If something went wrong during the run (a failed gate, a reviewer argument), say so. It's the most believable part.

**3. It doesn't die (1 min)**
- Quit VS Code completely. Reopen it. The session is still there and still working. "The agent never belonged to VS Code."
- If the trim happened, show the notification or the watcher's log: "its log was trimmed and it resumed on its own." If it didn't happen during the run, one sentence on what the trim does is enough.
- One line on network drops: "If the network drops mid-turn, the watcher waits for the API to come back and tells it to continue." If it happened during the run, show that notification.
- One line on stalls: "And if it ends a turn waiting on background work and nothing wakes it, the watcher notices the silence and tells it to check that work."

**4. Why not just a Ralph loop? (45 s)**
- A Ralph loop reruns the agent fresh every time: simple, robust, and a good default.
- What this adds: a reviewer on a different model, a test gate and a PR per batch, separate roles, and one session you can watch and steer.
- "So the kit does both: same agents, live session or Ralph mode."

**5. Close (15 s)**
- "It's all in the copilot-forever repo, linked below. Give it a goal and tell me what it builds."

---

## Editing (~30 minutes in Clipchamp)

1. Take 1, then the time-lapse clip, then take 2.
2. Cut dead air and long waits (Clipchamp's silence removal helps).
3. Automatic captions on.
4. A title card at the start; the repo link at the end.
5. Export 1080p. Optional: a 60-second vertical cut of the hook, the time-lapse and the finished app.
