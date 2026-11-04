<!-- copilot-forever: paste this section into your .agent.md (custom agent instructions).
     Paths are relative to the repository root; keep them in step with copilot-forever.config.json
     (`copilot-forever snippet` prints this text with your configured paths filled in). -->

## Long-running session: log trims at safe points

You run for days in one session. Its event log grows without limit, and a very long log slows or breaks resuming the session, so a watcher trims the log to your latest compaction while you are stopped. The trim drops only history before your latest successful compaction, which your context no longer contains anyway. You decide when it is safe.

**Safe point**: a moment when nothing you started is still running: no subagent, background task, terminal command, build, test run or review in flight, and no tool call awaiting an answer. Between work items is the natural place.

At **every safe point**:

1. Read `{{status}}`. It looks like this and is rewritten every few minutes:
   ```json
   {
     "session_id": "<copilot session id>",
     "ahp_session": "ahp-session:/<uuid>",
     "size_mib": 412.3,
     "threshold_mib": 400,
     "trim_due": true,
     "checked_at": "2026-11-04T10:20:00Z",
     "how_to_request": "…"
   }
   ```
   If the file is missing or `trim_due` is `false`, carry on.
2. If `trim_due` is `true`:
   1. Launch nothing new, and let everything you started finish.
   2. Append a handoff addendum to `{{handoff}}`: the date and time, what you are working on, the exact next step, open items and anything in flight elsewhere (branches, PRs, issues). Write it so a fresh session could pick up from it alone.
   3. Write `{{request}}`:
      ```json
      {
        "requested_at": "2026-11-04T10:21:00Z",
        "session_id": "<session_id from the status file>",
        "reason": "trim_due",
        "handoff": "{{handoff}}"
      }
      ```
   4. Stop: end your turn with a one-line note that you stopped for a log trim. Do not wait, poll or sleep.
3. You will receive a message starting with **"Continue."** once the trim is done (usually within 15 minutes). Read the latest addendum in `{{handoff}}` and resume from its next step. If that message says the trim did not happen, resume anyway; you will be asked again later.
4. A message starting **"Continue. Your last turn failed on a network error"** means your previous turn died on a network error and the watcher resumed you once the connection was back. Check where you were (git state, anything you started, the latest addendum in `{{handoff}}`) before you continue.
5. A message starting **"Continue. You ended your turn at"** means you ended a turn waiting on background work and its completion notification never reached you. Check that work's output now. For anything still running, wait in the foreground (a sync wait, or a read with a timeout) instead of ending your turn again.

Never write `{{request}}` while anything is running, and never edit `{{status}}`.
