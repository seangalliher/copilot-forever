#!/usr/bin/env node
// goal-loop gate: runs this repository's full test command on a committed, clean tree and writes
// a receipt that binds the result to the commit. Self-contained (Node >= 18, git), no dependencies.
//
//   node .goal-loop/gate.mjs --label <batch>             run the gate, write .goal-loop/receipts/<batch>.json
//   node .goal-loop/gate.mjs --verify <batch>            exit 0 only if that receipt passed for the current HEAD
//                                                         and the tree is still clean
//   options: --config <file> (default .goal-loop/config.json)  --dry-run  --allow-untracked
//
// Exit codes: 0 pass, 1 tests failed, 2 usage/config error, 3 refused (dirty tree, no commit),
//             4 verify failed.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const flag = (n) => args.includes(n);
const out = (m) => console.log(`gate: ${m}`);
const fail = (code, m) => { console.error(`gate: ${m}`); process.exit(code); };

function git(...a) {
  const r = spawnSync('git', a, { encoding: 'utf8' });
  if (r.status !== 0) fail(3, `git ${a.join(' ')} failed: ${(r.stderr || r.stdout || r.error?.message || '').trim()}`);
  return r.stdout.trim();
}

const root = (() => {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status !== 0) fail(3, 'not inside a git repository');
  return r.stdout.trim();
})();
const cfgFile = path.resolve(root, opt('--config') ?? '.goal-loop/config.json');
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
} catch (e) {
  fail(2, `cannot read ${cfgFile}: ${e.message}`);
}
const command = cfg?.gate?.command;
if (typeof command !== 'string' || !command.trim()) fail(2, `gate.command is not set in ${cfgFile}`);
const timeoutMin = Number(cfg.gate.timeoutMinutes ?? 30);
const receiptsDir = path.join(root, '.goal-loop', 'receipts');

const label = opt('--label') ?? opt('--verify');
if (!label || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(label)) fail(2, 'usage: --label <name> | --verify <name>  (letters, digits, . _ -)');
const receiptFile = path.join(receiptsDir, `${label}.json`);

/** Tracked or untracked changes that are not ignored. The gate refuses them. */
function dirtyEntries() {
  const s = git('status', '--porcelain', `--untracked-files=${flag('--allow-untracked') ? 'no' : 'normal'}`);
  return s ? s.split('\n').filter((l) => !l.slice(3).startsWith('.goal-loop/receipts/')) : [];
}

function headState() {
  const commit = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' });
  if (commit.status !== 0) fail(3, 'refusing: the repository has no commit yet');
  return { commit: commit.stdout.trim(), tree: git('rev-parse', 'HEAD^{tree}'), branch: git('rev-parse', '--abbrev-ref', 'HEAD') };
}

// ---- verify -------------------------------------------------------------------------------
if (opt('--verify')) {
  let r;
  try { r = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); } catch { fail(4, `verify failed: no receipt ${path.relative(root, receiptFile)}`); }
  const h = headState();
  const dirty = dirtyEntries();
  const problems = [];
  if (r.result !== 'pass') problems.push(`the receipt's result is ${r.result}`);
  if (r.commit !== h.commit) problems.push(`the receipt is for ${r.commit.slice(0, 12)}, HEAD is ${h.commit.slice(0, 12)}`);
  if (r.tree !== h.tree) problems.push('the tree differs from the gated tree');
  if (r.command !== command) problems.push('gate.command changed since the gate ran');
  if (dirty.length) problems.push(`the working tree is not clean (${dirty.length} entries)`);
  if (problems.length) fail(4, `verify failed: ${problems.join('; ')}`);
  out(`verify ok: ${label} passed for ${h.commit.slice(0, 12)} (${r.tests ?? 'test count unknown'}, ${r.durationSeconds} s)`);
  process.exit(0);
}

// ---- run ----------------------------------------------------------------------------------
const h = headState();
const dirty = dirtyEntries();
if (dirty.length) {
  fail(3, `refusing: the tree differs from HEAD; commit or stash first (the gate tests the committed tree):\n  ${dirty.slice(0, 20).join('\n  ')}`);
}
if (flag('--dry-run')) {
  out(`would run \`${command}\` on ${h.commit.slice(0, 12)} (${h.branch}) and write ${path.relative(root, receiptFile)}`);
  process.exit(0);
}

fs.mkdirSync(receiptsDir, { recursive: true });
if (fs.existsSync(receiptFile)) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  fs.renameSync(receiptFile, path.join(receiptsDir, `${label}.prev-${stamp}.json`));
}
const logFile = path.join(receiptsDir, `${label}.log`);
const log = fs.openSync(logFile, 'w');
const started = new Date();
out(`running \`${command}\` on ${h.commit.slice(0, 12)} (${h.branch}); output: ${path.relative(root, logFile)}`);

const hash = createHash('sha256');
let tail = '';
const child = spawn(command, { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: process.env.CI ?? 'true' } });
const onData = (d) => {
  fs.writeSync(log, d);
  hash.update(d);
  tail = (tail + d.toString('utf8')).slice(-4000);
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMin * 60000);

child.on('close', (code, signal) => {
  clearTimeout(timer);
  fs.closeSync(log);
  const finished = new Date();
  const after = dirtyEntries();
  const headAfter = git('rev-parse', 'HEAD');
  let result = code === 0 && !timedOut ? 'pass' : 'fail';
  const notes = [];
  if (timedOut) notes.push(`timed out after ${timeoutMin} min`);
  if (headAfter !== h.commit) { result = 'fail'; notes.push('HEAD moved while the gate ran'); }
  if (after.length) { result = 'fail'; notes.push(`the test command changed the tree (${after.slice(0, 5).join(', ')})`); }
  const tests = /(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)?/i.exec(tail)?.[0] ?? null;
  const receipt = {
    label,
    result,
    commit: h.commit,
    tree: h.tree,
    branch: h.branch,
    command,
    exitCode: code,
    signal: signal ?? null,
    tests,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationSeconds: Math.round((finished.getTime() - started.getTime()) / 1000),
    outputSha256: hash.digest('hex'),
    log: path.relative(root, logFile).replace(/\\/g, '/'),
    notes,
    tail: tail.split('\n').slice(-25).join('\n'),
  };
  fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
  out(`${result.toUpperCase()}: exit ${code}${notes.length ? ` (${notes.join('; ')})` : ''}, ${receipt.durationSeconds} s${tests ? `, ${tests}` : ''}`);
  out(`receipt: ${path.relative(root, receiptFile)}`);
  process.exit(result === 'pass' ? 0 : 1);
});
