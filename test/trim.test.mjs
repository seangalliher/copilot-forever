import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { findCut, liveLockPids, trimEvents, trimSession } from '../src/trim.mjs';
import { parseEvents } from '../src/schema.mjs';
import { Refusal } from '../src/util.mjs';
import { fixtureEvents, logger, makeSession, rm, SID, tmpDir } from './helpers.mjs';

const ids = (evs) => evs.map((e) => e.id);

test('findCut picks the latest successful compaction', () => {
  const ev = fixtureEvents('basic.jsonl');
  assert.equal(ev[findCut(ev).cut].type, 'session.compaction_start');
  assert.equal(ev[findCut(ev).cut].id, 'e012');
});

test('a failed latest compaction is skipped in favour of the earlier successful one', () => {
  const ev = fixtureEvents('failed-latest.jsonl');
  const { cut } = findCut(ev);
  assert.equal(ev[cut].id, 'e008');
  const later = ev.findIndex((e, i) => i > cut && e.type === 'session.compaction_start');
  assert.ok(later > cut, 'the failed compaction comes later');
  assert.equal(ev[later + 2].data.success, false);
});

test('only a failed compaction: nothing safe to trim', () => {
  const r = findCut(fixtureEvents('failed-only.jsonl'));
  assert.equal(r.cut, null);
  assert.match(r.reason, /no successful completed compaction/);
  assert.throws(() => trimEvents(fixtureEvents('failed-only.jsonl')), Refusal);
});

test('a compaction still in progress is not a cut point', () => {
  const ev = fixtureEvents('in-progress.jsonl');
  const { cut } = findCut(ev);
  assert.equal(ev[cut].id, 'e008');
});

test('no compaction: refuses', () => {
  assert.match(findCut(fixtureEvents('no-compaction.jsonl')).reason, /no compaction/);
});

test('trimEvents keeps header events and everything from the cut, re-parenting orphans', () => {
  const ev = fixtureEvents('basic.jsonl');
  const { kept, total, cut } = trimEvents(ev);
  assert.equal(total, 17);
  assert.equal(cut, 11);
  assert.deepEqual(ids(kept), ['e001', 'e002', 'e003', 'e012', 'e013', 'e014', 'e015', 'e016', 'e017']);
  assert.equal(kept[0].parentId, null);
  assert.equal(kept[1].parentId, 'e001');
  assert.equal(kept[3].parentId, 'e003', 'compaction_start re-parented onto the last header');
  assert.equal(kept[6].parentId, 'e003', 'user.message whose parent was cut is re-parented');
  assert.equal(kept[7].parentId, 'e015', 'kept parent links are untouched');
  const seen = new Set();
  for (const e of kept) {
    if (e.parentId !== null) assert.ok(seen.has(e.parentId), `${e.id} has a kept parent`);
    seen.add(e.id);
  }
  assert.equal(ev[11].parentId, 'e011', 'input objects are not modified');
});

test('null parentIds stay null; a subagent-scoped subagent.selected is not a header', () => {
  const { kept } = trimEvents(fixtureEvents('null-parent.jsonl'));
  assert.ok(!kept.some((e) => e.agentId === 'sub-1'));
  const root = kept.find((e) => e.type === 'model.turn_started');
  assert.equal(root.parentId, null);
});

function setup(fixture) {
  const root = tmpDir();
  const s = makeSession(root, fixture);
  return { root, ...s, archiveDir: path.join(root, 'archive') };
}

test('trimSession in place archives the full log first and writes a valid trimmed log', () => {
  const { root, stateDir, file, archiveDir } = setup('basic.jsonl');
  try {
    const original = fs.readFileSync(file, 'utf8');
    const r = trimSession({ sessionStateDir: stateDir, archiveDir, sessionId: SID, log: logger() });
    assert.equal(r.kept, 9);
    assert.ok(r.after < r.before);
    assert.equal(fs.readFileSync(r.archive, 'utf8'), original, 'archive is byte-identical');
    assert.ok(r.archive.startsWith(path.join(archiveDir, SID)));
    const back = parseEvents(fs.readFileSync(file, 'utf8')).events;
    assert.deepEqual(ids(back), ['e001', 'e002', 'e003', 'e012', 'e013', 'e014', 'e015', 'e016', 'e017']);
    assert.ok(!fs.readdirSync(path.dirname(file)).some((n) => n.endsWith('.tmp')), 'no temp file left');
  } finally { rm(root); }
});

test('trimSession dry-run changes nothing', () => {
  const { root, stateDir, file, archiveDir } = setup('failed-latest.jsonl');
  try {
    const before = fs.readFileSync(file, 'utf8');
    const log = logger();
    const r = trimSession({ sessionStateDir: stateDir, archiveDir, sessionId: SID, dryRun: true, log });
    assert.equal(r.dryRun, true);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.ok(!fs.existsSync(archiveDir));
    assert.ok(log.lines.some((l) => /would trim/.test(l)));
  } finally { rm(root); }
});

test('trimSession refuses while a live process holds the session lock', () => {
  const { root, stateDir, dir, file, archiveDir } = setup('basic.jsonl');
  try {
    fs.writeFileSync(path.join(dir, `inuse.${process.pid}.lock`), '');
    assert.deepEqual(liveLockPids(dir), [process.pid]);
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => trimSession({ sessionStateDir: stateDir, archiveDir, sessionId: SID, log: logger() }), /in use by PID/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally { rm(root); }
});

test('a stale lock (dead PID) does not block the trim', () => {
  const { root, stateDir, dir, archiveDir } = setup('basic.jsonl');
  try {
    fs.writeFileSync(path.join(dir, 'inuse.2147483646.lock'), '');
    const r = trimSession({ sessionStateDir: stateDir, archiveDir, sessionId: SID, log: logger() });
    assert.equal(r.kept, 9);
  } finally { rm(root); }
});

test('trimSession refuses an unknown log layout and leaves it untouched', () => {
  const { root, stateDir, file, archiveDir } = setup('unknown-version.jsonl');
  try {
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => trimSession({ sessionStateDir: stateDir, archiveDir, sessionId: SID, log: logger() }), /unknown log version 2/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally { rm(root); }
});

test('trimSession refuses when only a failed compaction exists', () => {
  const { root, stateDir, file, archiveDir } = setup('failed-only.jsonl');
  try {
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => trimSession({ sessionStateDir: stateDir, archiveDir, sessionId: SID, log: logger() }), /no successful completed compaction/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally { rm(root); }
});

test('a partial last line is dropped, not fatal', () => {
  const { root, stateDir, file, archiveDir } = setup('partial-last.jsonl');
  try {
    const log = logger();
    trimSession({ sessionStateDir: stateDir, archiveDir, sessionId: SID, log });
    assert.ok(log.lines.some((l) => /partial/.test(l)));
    assert.doesNotThrow(() => parseEvents(fs.readFileSync(file, 'utf8')));
  } finally { rm(root); }
});

test('--copy writes a trimmed copy under a new id and leaves the source alone', () => {
  const { root, stateDir, file, archiveDir } = setup('basic.jsonl');
  try {
    const before = fs.readFileSync(file, 'utf8');
    const newId = '00000000-0000-4000-8000-0000000000ff';
    trimSession({ sessionStateDir: stateDir, archiveDir, sessionId: SID, copyTo: newId, log: logger() });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    const dst = path.join(stateDir, newId);
    const ev = parseEvents(fs.readFileSync(path.join(dst, 'events.jsonl'), 'utf8')).events;
    assert.equal(ev[0].data.sessionId, newId);
    assert.match(fs.readFileSync(path.join(dst, 'workspace.yaml'), 'utf8'), new RegExp(`id: ${newId}`));
    assert.ok(fs.existsSync(path.join(dst, 'checkpoints', 'index.md')));
    assert.ok(!fs.existsSync(archiveDir));
  } finally { rm(root); }
});

test('rejects session ids that are paths', () => {
  assert.throws(() => trimSession({ sessionStateDir: '/x', archiveDir: '/y', sessionId: '../etc', log: logger() }), /not a session id/);
});
