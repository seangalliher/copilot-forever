#!/usr/bin/env node
// One-command setup on a new machine:
//
//   git clone https://github.com/seangalliher/copilot-forever.git && node copilot-forever/bootstrap.mjs --repo <your repo>
//
// Installs copilot-forever (npm ci, npm link), renders the goal-loop agents, standing orders, gate
// script and handoff template into <your repo>, writes its copilot-forever config, checks the tools
// the loop needs, and prints the remaining manual steps. Changes nothing outside the kit and <your repo>
// except the global `npm link`. Options:
//   --config <file>        goal-loop config (default: the repo's .goal-loop/config.json, else the example)
//   --dry-run              show what it would do; write nothing
//   --force                overwrite files bootstrap wrote before (GOAL.md is never overwritten)
//   --no-install           skip npm ci / npm link
//   --no-link              skip npm link only
//   --start                also install the watcher schedule and start the standalone host (persistent mode)
//   --allow-same-family    allow the reviewer on the builder's model family (not recommended)
import { parseArgs } from 'node:util';

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`copilot-forever needs Node 22 or newer (this is ${process.versions.node})`);
  process.exit(2);
}
const { bootstrap } = await import('./src/goal-loop.mjs');
const { Logger } = await import('./src/log.mjs');
const { Refusal } = await import('./src/util.mjs');

const { values: o } = parseArgs({
  options: {
    repo: { type: 'string' },
    config: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    'no-install': { type: 'boolean', default: false },
    'no-link': { type: 'boolean', default: false },
    'allow-same-family': { type: 'boolean', default: false },
    start: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (o.help || !o.repo) {
  console.log('usage: node bootstrap.mjs --repo <target repo> [--config <file>] [--dry-run] [--force] [--no-install] [--no-link] [--start]');
  process.exit(o.help ? 0 : 2);
}

const log = new Logger({ dryRun: o['dry-run'], prefix: 'bootstrap: ' });
try {
  await bootstrap({
    repo: o.repo, config: o.config, dryRun: o['dry-run'], force: o.force,
    install: !o['no-install'], link: !o['no-link'], allowSameFamily: o['allow-same-family'], start: o.start, log,
  });
} catch (e) {
  console.error(`bootstrap: ${e instanceof Refusal ? '' : 'error: '}${e.message}`);
  process.exit(e instanceof Refusal ? e.exitCode : 1);
}
