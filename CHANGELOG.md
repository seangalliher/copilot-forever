# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Goal loop** (`templates/goal-loop/`): Orchestrator, Architect, Builder and Diff Reviewer custom agents for GitHub Copilot; shared standing orders; a receipted gate script (`gate.mjs`); a handoff template; and a config for models, gate command, caps, merge policy and labels. Safe defaults: one human plan approval (`APPROVE PLAN`), caps, a STOP file, PRs only with no auto-merge, and a reviewer on a different model family (bootstrap refuses the same family).
- `bootstrap.mjs` and `copilot-forever goal-loop`: one-command setup on a new machine. Checks prerequisites, installs the kit, renders the templates into a repository without overwriting its own files, writes its keep-alive config, and prints the manual steps. `--dry-run` writes nothing.
- Demo (`demo/`): the Pocket Board goal, exact reproduction steps, a demo config, and a segment-by-segment video outline.

### Fixed

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
