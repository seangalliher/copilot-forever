#!/usr/bin/env node
// A fake GitHub CLI for tests: answers `issue list` and `pr list` (Ralph mode) and the `repo view`
// and branch-protection `api` calls (protect) from a state file. A PUT's body is recorded in it.
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
} else if (args[0] === 'repo' && args[1] === 'view') {
  if (!s.repo) { console.error('no git remotes found'); process.exit(1); }
  console.log(JSON.stringify({ nameWithOwner: s.repo, defaultBranchRef: s.branch ? { name: s.branch } : null }));
} else if (args[0] === 'api' && args.includes('PUT')) {
  if (s.putError) { console.log(JSON.stringify({ message: s.putError })); console.error(`gh: ${s.putError} (HTTP 403)`); process.exit(1); }
  s.put = { path: args.at(-3), body: JSON.parse(fs.readFileSync(0, 'utf8')) };
  fs.writeFileSync(stateFile, JSON.stringify(s));
  console.log('{}');
} else if (args[0] === 'api') {
  if (s.protected) console.log('{}');
  else { console.log(JSON.stringify({ message: s.readError ?? 'Branch not protected' })); console.error(`gh: ${s.readError ?? 'Branch not protected'} (HTTP ${/upgrade/i.test(s.readError ?? "") ? 403 : 404})`); process.exit(1); }
} else {
  console.error(`fake gh: unsupported ${args.join(' ')}`);
  process.exit(2);
}
