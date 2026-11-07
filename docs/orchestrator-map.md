# Orchestrator map

How the goal loop works, from one goal to merged pull requests: who does what, in what order, what is checked where, and where a person comes in. Everything here is taken from the agent files in [templates/goal-loop](../templates/goal-loop/README.md); when this map and an agent file disagree, the agent file is what runs.

## The whole loop on one screen

```mermaid
flowchart LR
  subgraph P1["Phase 1: goal to approved plan"]
    direction TB
    G["GOAL.md"] --> AI["Architect: intake<br/>writes PLAN.md"]
    AI --> HA{"Human:<br/>APPROVE PLAN?"}
    HA -->|changes| AI
    HA -->|yes| AF["Architect: file-issues<br/>(capped, labelled)"]
    AF --> Q[("GitHub issue queue")]
  end

  subgraph P2["Phase 2: one batch at a time"]
    direction TB
    CK{"STOP file?<br/>cap reached?"} -->|no| PB["pick batch: first unblocked<br/>issue + up to 2 coupled"]
    CK -->|yes| HO["handoff, stop"]
    PB --> IS["per issue: Builder,<br/>review rounds, commit"]
    IS -.->|"round cap reached"| PK["park: needs-human"]
    IS --> GT{"gate.mjs:<br/>full tests"}
    GT -->|red| IS
    GT -->|green| PR["verify, push,<br/>one PR per batch"]
    PR --> MG["merge: human, or agent<br/>after green CI"]
    MG --> VC["verify issues closed,<br/>handoff addendum"]
    VC --> CK
    VC -.->|"queue empty"| DN["final addendum, stop"]
  end

  P1 ==> P2
```

## One batch in detail

```mermaid
sequenceDiagram
  autonumber
  participant O as Orchestrator
  participant A as Architect
  participant B as Builder
  participant R as Diff Reviewer<br/>(other model family)
  participant T as gate.mjs
  participant GH as GitHub

  O->>GH: gh issue list (queue), pick batch, label in-progress
  loop each issue in the batch
    opt issue unclear or a design choice is open
      O->>A: build-prompt (verify-first against the code)
      A-->>O: .goal-loop/prompts/ISSUE.md
    end
    O->>B: one issue, branch, files in scope, focused test command
    B-->>O: changes left unstaged + report (files, tests, criteria)
    O->>O: run the focused tests itself, stage files by name
    loop review round, at most maxReviewRounds
      O->>R: staged diff, what it claims, the consumer that must accept it
      R-->>O: findings + verdict
      alt blocking findings
        O->>B: fresh delegation with the exact findings
        B-->>O: repair
      end
    end
    alt still not ready after the last round
      O->>GH: label needs-human, comment open findings, move out of batch
    else ready
      O->>O: deletion check, commit locally
    end
  end
  O->>T: gate --label BATCH (clean, committed tree)
  T-->>O: receipt (pass/fail, commit, tree, duration)
  O->>T: gate --verify BATCH just before the push
  O->>GH: push branch, gh pr create (Closes #N, review rounds, receipt)
  O->>GH: merge per policy, then gh issue view each issue: closed?
  O->>O: handoff addendum
```

## Roles

| Role | Model (default) | Does | Never |
|---|---|---|---|
| **Orchestrator** | `claude-sonnet-5.5` | Runs the loop: plan approval, batching, every delegation, focused-test check, staging, commits, the gate, push, PR, merge (if the policy allows), closure, handoff. | Pushes to the default branch, enables auto-merge, treats an automated "Continue." as plan approval. |
| **Architect** | `claude-sonnet-5.5` | `intake` (plan), `file-issues` (after approval), `build-prompt` (verify-first), `triage` (failures). | Edits code or tests, closes issues, pushes, merges. |
| **Builder** | `claude-sonnet-5.5` | Implements one issue with focused tests; repairs exactly the findings it is given. | Makes design decisions, adds dependencies, stages, commits, weakens a test. Stops and reports instead of guessing. |
| **Diff Reviewer** | `gpt-6.1-sol` (fallback `gpt-6-luna`) | Asks "does the next consumer accept this change?": renders what crosses the boundary, probes untested paths, checks that each test would fail without the fix. | Edits, stages or commits; approves because tests pass. |

The reviewer must be a different model family from the Builder; bootstrap refuses a same-family config. Models are passed explicitly on every delegation.

## Decision points

| When | The Orchestrator |
|---|---|
| Before every delegation, gate and push | Checks `.goal-loop/STOP`. If present: writes the handoff and stops. |
| Before each batch | Checks the caps (`maxBatchesPerRun`, `maxIssuesPerPlan`, `maxDiscoveredIssuesPerRun`). If one is reached: finishes the batch in hand, writes the handoff, stops. |
| The plan is shown | Waits. Only a human message containing `APPROVE PLAN` counts. |
| Picking a batch | Takes the first issue whose dependencies are closed, plus up to `maxBatchSize - 1` issues tightly coupled to it (a dependency, or the same files or interface). Never unrelated issues. |
| An issue is unclear | Asks the Architect for a verify-first build prompt instead of sending the issue straight to the Builder. |
| The Builder hits a hard stop | Sends it to the Architect for triage; a decision reserved for the human goes to the human. |
| Review finds a blocker or a repair regression | Fresh Builder delegation with the exact findings, then a delta review (a full review if a shared interface changed). |
| Review finds code the issue does not need (size) | Deletes it with the round's other repairs; from round 2 on, only leftovers the change itself made unused are deleted and other size findings go to the follow-up issue. A size-only repair that just removes code the change added runs the focused tests with no further review round. |
| Review round `maxReviewRounds` ends not ready | Parks the issue (`needs-human` label, comment with open findings and a recommendation) and continues with independent work. |
| The gate is red | Finds the issue that caused it, repairs, re-reviews, commits, gates again. |
| Merge policy `human` | Starts the next batch only if it doesn't depend on the unmerged PR; otherwise writes the handoff and waits with a watchdog. |
| Merge policy `agent-after-green` | Merges only after green CI checks and a receipt that matches the PR head. A repository with no CI is treated as `human`. |
| After a merge | Checks each issue's state; closes any GitHub missed, with a comment linking the PR. |
| Finding new problems | Files immediately only for security, data integrity or a blocker; everything else goes into one follow-up issue per batch. |
| No unparked issue left | Final addendum (what was built, PRs, receipts, review rounds, parked items, wall-clock time), then stops. |

## Where state lives

| State | Where | Read by |
|---|---|---|
| The goal | `.goal-loop/GOAL.md` | Architect (intake) |
| The plan and its approval | `.goal-loop/PLAN.md` (`Approved: <time>` at the top) | Orchestrator, Architect |
| The work queue | GitHub issues labelled `goal-loop`, `goal-loop:in-progress`, `goal-loop:needs-human` | Orchestrator |
| Build prompts | `.goal-loop/prompts/<issue>.md` | Builder |
| Gate receipts | `.goal-loop/receipts/<batch>.json` | Orchestrator (`--verify`), the PR description |
| Where the run is | `.goal-loop/handoff.md`: one addendum per batch, safe point and stop | A resumed or fresh Orchestrator |
| Settings | `.goal-loop/config.json` (models, gate command, caps, merge policy, labels) | Every agent |

A fresh session must be able to resume from the latest handoff addendum alone. That is what lets the same loop run as one long session or as a [Ralph loop](../templates/goal-loop/README.md#ralph-mode).

## Where a person comes in

1. **Writing the goal.**
2. **Approving the plan** with `APPROVE PLAN` (or `copilot-forever loop approve-plan` in Ralph mode).
3. **Merging PRs,** under the default `human` merge policy.
4. **Parked issues:** anything still not ready after the last review round, or a decision the standing orders reserve for a human (destructive data operations, weaker security, a breaking public interface, spending, credentials, production access, a change to the goal).
5. **Stopping it:** create `.goal-loop/STOP`; delete it and send `resume` to continue.

Everything else runs without you.

## What is enforced by code, and what by instructions

| Enforced by code | Enforced by the agents' instructions |
|---|---|
| `gate.mjs`: refuses a dirty tree, binds the receipt to the commit and tree, fails if tests change tracked files; `--verify` fails if anything changed before the push | Plan approval, caps, the STOP file |
| Bootstrap refuses a reviewer from the Builder's model family | Review before every commit, the round cap |
| GitHub branch protection (turn it on): PRs and passing checks for the default branch | PRs only, merge policy, closure check |
| Ralph mode: `--deny-tool` rules, `--max-ai-credits`, run caps, stall guard | Filing rules, escalation instead of guessing |

Turn on branch protection: it is the guard that holds even if an agent ignores its instructions.

## How the keep-alive kit fits in (persistent session)

The loop above runs inside one Orchestrator session. [copilot-forever](../README.md#the-keep-alive-kit) keeps that session going:

```mermaid
flowchart LR
  W["watcher, every 10 min"] -->|status file: size, trim_due| O["Orchestrator"]
  O -->|"at a safe point with trim_due:<br/>handoff addendum, request file, stop"| W
  W -->|"stop host, trim log to the latest<br/>compaction, restart host"| H["standalone agent host"]
  W -->|"Continue. (trim done)"| O
  W -->|"Continue. (network error, API back)"| O
  O -->|"reads the latest addendum, resumes"| O
```

- **Safe point:** nothing the Orchestrator started is still running. Between batches is the natural one. The Orchestrator checks the status file there and requests a trim only when `trim_due` is true.
- **Network resume:** if a turn dies on a network error, the watcher sends a continue once the model API answers again (capped per error and per day).
- Both continue messages start with "Continue." and point at the handoff. Neither counts as plan approval.

In Ralph mode none of this is needed: each run is a fresh `copilot -p` process that reads the handoff and the issues, does one step, and exits.
