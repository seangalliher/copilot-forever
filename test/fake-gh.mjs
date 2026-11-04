#!/usr/bin/env node
// A fake GitHub CLI for Ralph-mode tests: answers `issue list` and `pr list` from a state file.
import fs from 'node:fs';

const argv = process.argv.slice(2);
const stateFile = argv[argv.indexOf('--state') + 1];
const args = argv.slice(argv.indexOf('--state') + 2);
const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
if (s.ghFails) { console.error('fake gh: failing on purpose'); process.exit(1); }
if (args[0] === 'issue' && args[1] === 'list') {
  const label = args[args.indexOf('--label') + 1];
  console.log(JSON.stringify((s.issues ?? []).filter((i) => i.labels.some((l) => l.name === label))));
} else if (args[0] === 'pr' && args[1] === 'list') {
  console.log(JSON.stringify(s.prs ?? []));
} else {
  console.error(`fake gh: unsupported ${args.join(' ')}`);
  process.exit(2);
}
