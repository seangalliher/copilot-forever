# Video script: "I gave GitHub Copilot one goal and let it build for a day"

Demo app: **LoopBoard**, a local-first kanban board. Demo repo: `seangalliher/loopboard`.
Models: **Claude Sonnet 5.5** for Orchestrator, Architect and Builder; **GPT-6.1 Sol** for the Diff Reviewer.
Target length: 18–20 minutes. Everything runs in GitHub Copilot (VS Code Agents window). No other tools.

---

## The demo goal (paste into `demo/GOAL.md` and into the Architect)

> **Goal: build LoopBoard, a local-first kanban board that runs in the browser.**
>
> **Must have**
> - Three columns (To do, Doing, Done) with add, edit and delete for cards (title, optional note, optional due date).
> - Move cards by drag and drop **and** by keyboard (accessible: focus order, ARIA labels, visible focus).
> - A work-in-progress limit per column, set by the user; the column warns when it is over the limit.
> - Everything persists in `localStorage`; export the board to JSON and import it back.
> - Light and dark themes, following the system setting with a manual toggle.
> - Works on a phone-width screen.
>
> **Engineering**
> - Vite + TypeScript, no UI framework. Unit tests with Vitest for the board logic; one Playwright smoke test (add a card, move it, reload, it is still there).
> - GitHub Actions CI running lint, unit tests and the smoke test on every PR.
> - Deploy to GitHub Pages from `main`.
>
> **Not in scope:** accounts, a backend, sync between devices, multiple boards.
>
> **Done when:** every issue is closed, CI is green on `main`, and the board is live on GitHub Pages.

Why this goal: it's visual (good on camera), needs no API keys or accounts, has real logic to test (moves, limits, import/export), and splits into about 10–12 issues. That's a few hours of loop time, enough to show batching, review rounds and a trim, short enough to finish in a day.

---

## Before you record

- [ ] **A clean machine or a fresh Windows user account**, so the setup segment is honest. Keep this list on a second screen.
- [ ] **Screen recorder** set to record the whole desktop at 1080p or higher, plus a separate low-frame-rate capture (one frame every 5–10 s) for the time-lapse.
- [ ] **Lower the trim threshold for the demo** so a trim happens on camera: in `copilot-forever.config.json` set `thresholdMiB` to about `25`. Say so in the video. Put it back to `400` afterwards.
- [ ] **Turn on notifications** (Windows: Focus off) so the "trimmed and resumed" toast is visible.
- [ ] **Create the empty `loopboard` repo** on GitHub only when you reach that segment. Creating it on camera is part of the story.
- [ ] **Decide on keeping failures in.** If a gate fails or a reviewer catches a real bug, keep it: that's the strongest moment of the video.
- [ ] **Note the start time and Copilot usage** (AI credits) so you can report time and cost at the end.

---

## Segment 0: cold open (0:00–0:40)

**On screen:** the time-lapse of the board being built: issues closing, PRs merging, ending on the live LoopBoard at its GitHub Pages URL.

**Say:**
"I gave GitHub Copilot one goal, approved one plan, and then mostly left it alone. Nine hours later [use your real number] it had filed its own issues, written the code, had every change reviewed by a different AI model, and shipped this, live. In this video I'll show you exactly how, and how you can run the same loop on your machine."

---

## Segment 1: the problem (0:40–2:40)

**On screen:** a normal Copilot chat doing one task; then the two failure screenshots or issue pages.

**Say:**
"Most AI coding today is one task at a time: you ask, it answers, you check, you ask again. You're the loop. I wanted the loop to run without me: plan the work, build it, review it, test it, ship it, and keep going.

When you try to run one Copilot session for hours or days, you hit two walls.
**Wall one:** close VS Code, or let it update, and the agent session dies with it.
**Wall two:** a long session's log keeps growing, hundreds of megabytes a day. VS Code gets slow, and big sessions can fail to resume. There are open issues on the Copilot CLI about exactly this.

So there are really two parts to this project: a way of working, the agent team, and the plumbing that keeps it alive."

**Capture:** github/copilot-cli issues #4325 and #4664 on screen for a few seconds.

---

## Segment 2: how it works (2:40–5:00)

**On screen:** the architecture diagram from the copilot-forever README. Zoom into each part as you name it.

**Say:**
"Here's the whole thing on one screen.

**The team.** Four Copilot custom agents.
- The **Architect** turns a goal into a plan and files GitHub issues. Those issues are the work queue.
- The **Builder** takes one issue at a time and writes the code and the tests for it.
- The **Diff Reviewer** reviews every change before it's committed. It runs on GPT-6.1 Sol while the Builder runs on Claude Sonnet 5.5. A different model family catches different mistakes; it's a second opinion, not the author grading its own work.
- The **Orchestrator** runs the loop. It picks the next issues, hands them out, sends the reviewer's findings back for repair, runs the test gate once per batch, opens the PR and checks the issues really closed.

**The guard rails.** I approve the plan once before any issue is filed. All work goes through pull requests, with no auto-merge on the default branch. There's a cap on how many issues it can file, and a STOP file that halts it at the next safe point.

**The plumbing: copilot-forever.**
- The session runs on a standalone agent host, a separate process from VS Code, so closing VS Code doesn't touch it.
- When the log gets big, the Orchestrator stops itself at a safe point. A small watcher trims the log back to its latest summary, keeping the full log in an archive, restarts the host and tells the Orchestrator to continue, all on its own."

---

## Segment 3: setup on a clean machine (5:00–7:30)

**On screen:** terminal and VS Code, real time (cut the waits).

**Do and say:**
1. "Fresh machine. I need VS Code, GitHub Copilot, Node and the GitHub CLI." Show them installed.
2. Clone copilot-forever and run the bootstrap. "One command: it installs the keep-alive kit, starts the standalone agent host, and registers the watcher to run every 10 minutes." Show the output.
3. Create the `loopboard` repo on GitHub and clone it. Run the template step that copies the four agents and the standing orders into it. Show `.github/agents/` in the explorer.
4. "Models: Sonnet 5.5 for the Orchestrator, Architect and Builder; GPT-6.1 Sol for the reviewer." Show the `model:` lines.
5. Add the standalone host to VS Code, as the bootstrap printed. In the Agents window, start a new session on **that** host, folder `loopboard`. "This is the one session that will run the whole build."

**Capture:** the host name in the session picker, which proves it isn't VS Code's built-in host.

---

## Segment 4: goal → plan → issues (7:30–10:00)

**On screen:** the Agents window, then GitHub Issues.

**Do and say:**
1. Paste the goal. "This is everything I'm going to tell it."
2. The Architect returns a plan. Read out two or three items. "It's asking me to approve the plan before it files anything. That's the one human checkpoint I want." Approve it (or change one thing on camera, which shows you're in control).
3. Switch to GitHub: issues appear with acceptance criteria, dependencies and labels. "That's the queue. From here on, I'm mostly watching."

**Capture:** the issue list filling up; open one issue to show its acceptance criteria.

---

## Segment 5: the loop running (10:00–13:30)

**On screen:** mostly time-lapse, with real-time cut-ins at the moments below.

**Cut-ins, in order:**
1. **The batch.** The Orchestrator picks up to three related issues. "It batches issues that touch the same code, so one test run covers them."
2. **The Builder at work:** code and focused tests for one issue.
3. **A review round.** Show a real finding from GPT-6.1 Sol and the repair. "Round one found [the real finding]. The Builder fixed it, and the reviewer checked only what changed." If a review hits round three, show the escalation: "after three rounds it stops and asks for help instead of looping forever."
4. **The gate.** One full test run per batch, and the receipt file. "Nothing is pushed without a green gate and the receipt to prove it."
5. **The PR**: CI green, merged, issues closed by the Orchestrator checking each one.

**Say over the time-lapse:**
"This is the part that used to be me: picking the next task, checking the work, running the tests, opening the PR. Now I check in a few times and read the PR descriptions."

---

## Segment 6: it doesn't die (13:30–15:30)

**On screen:** real time.

**Do and say:**
1. **Quit VS Code** in the middle of a build. Wait ten seconds. Reopen it and open the session. "I just closed the whole editor, and it never stopped. The log has no gap." Show the session still working (`code agent ps` in a terminal makes it obvious).
2. **The trim.** "I set the trim size very low for this video so you can see it." The Orchestrator reaches a safe point, writes its handoff and says it stopped for a log trim. Within ten minutes the notification appears: *Orchestrator log trimmed and resumed*. Show the log size before and after, and the session picking up from its handoff.

**Capture:** the toast, the file sizes, the Orchestrator's first message after the resume.

---

## Segment 6b: why not just a Ralph loop? (15:30–17:00)

**On screen:** a terminal with the five-line Ralph loop; then the README's comparison table; then the Ralph mode running the same goal for a few seconds.

**Say:**
"If you've seen the Ralph loop, you're probably asking why I didn't just do that. A Ralph loop is a `while` loop that runs the agent with the same prompt again and again. Every run starts fresh, and the state lives in files. It's simple and it's robust: the log never grows, and a crash costs you one iteration. There are good recipes for it in GitHub's awesome-copilot repo.

Here's what I wanted on top of that.
- **A second opinion on every change.** A basic Ralph loop trusts the tests. Here a reviewer on a different model family reads every diff, and in my own projects it catches real bugs in the first few rounds that the tests missed.
- **A gate and a PR per batch,** so nothing ships without proof.
- **Roles.** The planner plans, the builder builds, and the orchestrator decides what's next, instead of one prompt doing everything.
- **One session I can watch and steer** in VS Code, which remembers what went wrong earlier.

To be fair to Ralph: my trim is really a soft restart from the last summary, and Copilot compacts on its own every couple of hours anyway. So I built both. The same four agents run either way: as one live session with copilot-forever keeping it alive, or as a Ralph-style loop that starts a fresh orchestrator for every batch. Use Ralph mode if you want simple and robust. Use the live session if you want to watch it and steer it."

**Capture:** the comparison table, and `copilot-forever loop --mode ralph` (check the real command name in the README before recording) starting its first iteration on the same LoopBoard goal.

---

## Segment 7: the result (17:00–18:30)

**On screen:** the live app, then the repo's insights.

**Do and say:**
1. Open LoopBoard on its GitHub Pages URL. Add a card, drag it, move one with the keyboard, hit the WIP limit, switch to dark mode, reload and show it's still there. Open it on your phone too.
2. The numbers, real ones only: "X issues, Y pull requests, Z review findings fixed, N gate runs, H hours, and this much Copilot usage."
3. "What I did: wrote one goal, approved one plan, and checked in a few times."

---

## Segment 8: wrap-up (18:30–19:30)

**Say:**
"Two things to take away. First, the pattern: a planner, a builder, a reviewer on a different model, and an orchestrator with a test gate, all working from GitHub issues. Second, the plumbing that keeps one session alive for days. Both are in the copilot-forever repo, linked below, and the README walks through setup on a new machine.

It isn't magic. It still needs a clear goal, good tests and someone checking in. But the loop runs without you. If you try it, tell me what you build."

**On screen:** the repo URL, your channel and links.

---

## After recording

- [ ] Set `thresholdMiB` back to `400`.
- [ ] Check the recording for secrets: the host token, `gh auth` output, notification previews, browser tabs.
- [ ] Put the real numbers in the description: hours, issues, PRs, review findings, usage.
- [ ] Link the `loopboard` repo so viewers can see every issue and PR the loop produced.
