#!/usr/bin/env node
// A fake Copilot CLI for Ralph-mode tests:  node fake-copilot.mjs --state <state.json> -p "<prompt>" ...
// Records its arguments, reads the prompt file the -p text names, and acts out the phase on the
// fake GitHub state (shared with fake-gh.mjs): plan writes PLAN.md, file adds issues, batch closes
// one issue and opens a PR, unless state.behavior says 'stall' (do nothing) or 'fail' (exit 1).
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const stateFile = argv[argv.indexOf('--state') + 1];
const args = argv.slice(argv.indexOf('--state') + 2);
const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
s.calls = [...(s.calls ?? []), { args, cwd: process.cwd(), envHasClaudeCode: 'CLAUDECODE' in process.env }];

const prompt = args[args.indexOf('-p') + 1] ?? '';
const rel = /read (\S+) and follow it/.exec(prompt)?.[1];
const text = rel ? fs.readFileSync(path.join(process.cwd(), rel), 'utf8') : '';
const phase = /phase (\w+)/.exec(text)?.[1];
const now = () => new Date(Date.now() + (s.tick = (s.tick ?? 0) + 1) * 1000).toISOString();
console.log(`fake copilot: phase ${phase}`);

if (s.behavior === 'fail') { save(); process.exit(1); }
if (s.behavior !== 'stall') {
  if (phase === 'plan') {
    fs.writeFileSync(path.join(process.cwd(), '.goal-loop', 'PLAN.md'), '# Plan\n\n## 1. Skeleton\n\n## 2. Board\n\n## 3. Themes\n');
  } else if (phase === 'file') {
    s.issues = [1, 2, 3].map((n) => ({ number: n, state: 'OPEN', labels: [{ name: 'goal-loop' }], updatedAt: now() }));
  } else if (phase === 'batch') {
    const next = s.issues.find((i) => i.state === 'OPEN' && !i.labels.some((l) => l.name === 'goal-loop:needs-human'));
    if (next) {
      next.state = 'CLOSED';
      next.updatedAt = now();
      s.prs = [...(s.prs ?? []), { number: 100 + next.number, state: 'MERGED', updatedAt: now(), headRefName: `goal-loop/batch-${next.number}` }];
    }
  }
  fs.appendFileSync(path.join(process.cwd(), '.goal-loop', 'handoff.md'), `\n## Addendum ${now()}\n- phase ${phase}\n`);
}
save();
process.exit(s.exitCode ?? 0);
