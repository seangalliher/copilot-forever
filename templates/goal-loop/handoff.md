# Handoff

The Orchestrator appends an addendum here after every batch, before every stop and at every safe point. A fresh session resumes from the **latest addendum alone**, so each one is complete on its own. Newest at the bottom.

Template (copy for each addendum):

```markdown
## Addendum <UTC date and time>

- **Why this addendum:** batch done | safe point | log trim | stop file | cap reached | blocked | done
- **Goal:** .goal-loop/GOAL.md; plan .goal-loop/PLAN.md (approved <time>)
- **Run counts:** batches <n> of <caps.maxBatchesPerRun>; issues filed <n>; discovered issues filed <n>
- **Merged:** #<pr> (closes #<n>, #<n>), ...
- **Open PRs:** #<pr>: <state, CI, what it waits for>
- **In flight:** <issue>, branch <name>, phase <build | review round N | gate | PR>, last commit <sha>
- **Next step:** <the exact next action>
- **Parked (needs a human):** #<n>: <decision needed, recommendation>
- **Gate receipts:** .goal-loop/receipts/<label>.json: <pass/fail, commit>
- **Notes:** <anything a fresh session would otherwise rediscover>
```

---
