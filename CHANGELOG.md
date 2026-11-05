# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Effort per role** (`effort` in the goal-loop config): demo and default levels Architect max, Orchestrator high, Builder high, Diff Reviewer max. The bootstrap writes the subagents' levels to Copilot's user settings (`subagents.agents.<name>.effortLevel`, verified to apply on the VS Code agent host); the Orchestrator's level goes in the chat's model picker, and Ralph mode passes it as `--reasoning-effort`. `--no-effort` leaves the settings alone.
- **Agent name prefix** (`agents.namePrefix`, default `Goal `): the agents are Goal Orchestrator, Goal Architect, Goal Builder and Goal Diff Reviewer, so their user-wide effort settings never collide with other agents named Architect or Builder.

- **Goal loop** (`templates/goal-loop/`): Orchestrator, Architect, Builder and Diff Reviewer custom agents for GitHub Copilot; shared standing orders; a receipted gate script (`gate.mjs`); a handoff template; and a config for models, gate command, caps, merge policy and labels. Safe defaults: one human plan approval (`APPROVE PLAN`), caps, a STOP file, PRs only with no auto-merge, and a reviewer on a different model family (bootstrap refuses the same family).
- `bootstrap.mjs` and `copilot-forever goal-loop`: one-command setup on a new machine. Checks prerequisites, installs the kit, renders the templates into a repository without overwriting its own files, writes its keep-alive config, and prints the manual steps. `--dry-run` writes nothing.
- **Ralph mode** (`copilot-forever loop --mode ralph`): the same agents run as fresh `copilot -p` Orchestrator runs, one step per run (plan, file issues, one batch), with the agent and model pinned on every call. It stops on an empty queue, the STOP file, the caps, or a stall guard. Plan approval is `copilot-forever loop approve-plan`, bound to the plan's hash. Each run is logged to `.goal-loop/ralph/runs.jsonl`. Dry-run mode. Needs no standalone host, trim or AHP client.
- `bootstrap.mjs --start`: also schedules the watcher and starts the standalone host (persistent mode).
- The Orchestrator accepts a goal pasted into the chat and saves it to `.goal-loop/GOAL.md`.
- Demo (`demo/`): the LoopBoard goal, reproduction steps for both modes, a demo config, and the video script.
- README: "Persistent session or Ralph loop?" comparison.
- [Orchestrator map](docs/orchestrator-map.md): the goal loop end to end, with diagrams of the whole loop and of one batch, the roles, every decision point, where state lives, where a person comes in, what code enforces versus what the agents' instructions do, and how the keep-alive kit fits in.
- **Network resume**: when the session's last turn died on a network error (DNS, connection, timeout, 5xx), the watcher sends a continue once the model API answers again. Never after auth, quota, rate-limit, policy, cancel or unrecognised errors; at most `resume.maxTries` continues per error and `resume.maxPerDay` across errors, then one notification. Configured under `resume`.
- **Stall resume**: when the agent's last working turn launched background work (an async shell or a background task) and ended to wait for it, but no completion notification ever woke it, the watcher sends a continue naming that work after `stall.quietMinutes` of quiet (or the longest `Start-Sleep` in that turn plus 5 minutes). Never after `task_complete` or `ask_user`, or when the log ends in an error; at most `stall.maxTries` per stall and `stall.maxPerDay` in all, then one notification. Seen on a real standalone host: after a network error, no completion notification arrived for the rest of the session, and the orchestrator sat idle for 5.5 hours. Configured under `stall`.

### Changed

- Default models: `claude-sonnet-5.5` for the Orchestrator, Architect and Builder; `gpt-6.1-sol` for the Diff Reviewer.

### Fixed

- Windows: `uninstall --stop-host` now stops the running host. Before, it deleted the scheduled tasks and reported "uninstalled." while the host kept running (seen on a real Windows install: deleting a task did not stop the process it started). It now takes the watcher lock (refusing, with nothing changed, while a watcher run such as a trim is in progress), deletes the watcher task, stops the host and checks that its port has closed, then deletes the host task. If the stop fails, the host task stays installed and the error says what is left and what to do next.
- A trim no longer fails to restart the host when the killed host's listening socket outlives it briefly (seen on Windows): `stopHost` waits up to 30 s for the port to close, so the restart doesn't find the port "already listening" and skip the start.
- Windows: the scheduled tasks no longer flash a console window on every run. They now start through `conhost.exe --headless`; run `install` again to update existing tasks.
- The agent snippet now tells the agent what to do with a network-resume "Continue." message, not only a trim one.
- The watcher lock and the host log are now per instance (`watch-<instanceName>.lock`, `host-<instanceName>.log`), so two instances sharing a state folder no longer block each other.

## [0.1.0] - 2026-11-04

First public version: a generic, cross-platform port of a working Windows setup (PowerShell and Python scripts) that keeps one orchestrator session alive. Reference implementation in validation: a full automatic trim cycle has not yet completed on a real session.

### Added

- `host start|stop|status`: the standalone VS Code agent host on localhost with an owner-only connection token, started from a clean environment, with the token masked in its log. `--foreground` supervises it for systemd and launchd.
- `trim`: cuts `events.jsonl` at the latest compaction whose `session.compaction_complete` has `success: true`. It keeps header events, re-parents orphans, archives the full log first, replaces the log atomically and verifies the result. It refuses while the session is in use. `--copy <new-id>` writes a trimmed copy instead.
- `watch`: a status file for the agent, and a trim on request at an agent-chosen safe point. The session must be idle on two checks. Safety checks run before anything is stopped. Then the host is stopped, the log trimmed, the host restarted, the continue message sent and a notification shown.
- `continue`: sends the continue message over the Agent Host Protocol using Microsoft's `@microsoft/agent-host-protocol` client. It reuses the last user message's model and custom agent, refuses a busy chat, and succeeds only when the agent starts working. `--probe` is read-only.
- `install`/`uninstall`: Windows Task Scheduler, macOS launchd agents, Linux systemd user service and timer.
- `doctor`, `init`, `snippet`; `--dry-run` on every command.
- Safety gates: Copilot CLI and runtime major-version check; a log-schema check that refuses unknown layouts.
- Desktop notifications on Windows (toast), macOS (`osascript`) and Linux (`notify-send`), always logged as well.
- Agent-side snippet for any `.agent.md`: the safe-point rule, handoff addendum, and status and request file formats.
- Tests: synthetic `events.jsonl` fixtures (including failed and in-progress compactions), a fake AHP WebSocket server, and an end-to-end trim cycle against a fake host. CI on Windows, macOS and Ubuntu with Node 22 and 24.
