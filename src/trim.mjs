// Trims a stopped Copilot session's events.jsonl to its latest successful compaction.
//
// The model's context after a compaction is the compaction summary plus what follows it, so
// cutting just before the latest session.compaction_start whose session.compaction_complete has
// data.success === true drops nothing the model still uses. The session-start header events are
// kept; an event whose parent was cut is re-parented onto the last kept header event.
//
// A failed compaction (copilot-cli #4663) leaves no usable summary: it is never a cut point.
import fs from 'node:fs';
import path from 'node:path';
import { checkSchema, parseEvents, SchemaError } from './schema.mjs';
import { pidAlive } from './proc.mjs';
import { exists, mib, Refusal, stampUtc, writeFileAtomic } from './util.mjs';

export const HEADER_TYPES = new Set(['session.start', 'subagent.selected', 'session.mode_changed',
  'session.permissions_changed', 'session.mode_notice_delivered']);
const HEADER_WINDOW = 50;

/** Index of the cut: the latest compaction_start whose next compaction event is a successful complete. */
export function findCut(events) {
  const starts = [];
  events.forEach((e, i) => { if (e.type === 'session.compaction_start') starts.push(i); });
  if (!starts.length) return { cut: null, reason: 'no compaction in this session: nothing to trim' };
  for (let k = starts.length - 1; k >= 0; k--) {
    const s = starts[k];
    let done = null;
    for (let j = s + 1; j < events.length; j++) {
      const t = events[j].type;
      if (t === 'session.compaction_complete' || t === 'session.compaction_start') { done = events[j]; break; }
    }
    if (done?.type === 'session.compaction_complete' && done.data?.success === true) return { cut: s, reason: null };
  }
  return { cut: null, reason: 'no successful completed compaction in this session: nothing safe to trim' };
}

/**
 * Compute the trimmed event list. Pure: does not touch the input objects.
 * @returns {{ kept: any[], total: number, cut: number }}
 */
export function trimEvents(events) {
  const { cut, reason } = findCut(events);
  if (cut === null) throw new Refusal(reason, 4);
  // Header: session-level setup events near the start. Subagent-scoped ones (with agentId) are not
  // the session's own agent selection and stay out.
  const head = events.slice(0, Math.min(cut, HEADER_WINDOW)).filter((e) => HEADER_TYPES.has(e.type) && e.agentId === undefined);
  if (!head.length || head[0].type !== 'session.start') throw new SchemaError('unexpected log: the first event is not session.start');
  const kept = [...head, ...events.slice(cut)].map((e) => ({ ...e }));
  const ids = new Set();
  kept.forEach((e, i) => {
    // A null parentId is a root by design (e.g. model.turn_started in 1.0.10x): leave it alone.
    if (i && e.parentId !== null && !ids.has(e.parentId)) e.parentId = i < head.length ? kept[i - 1].id : head[head.length - 1].id;
    ids.add(e.id);
  });
  return { kept, total: events.length, cut };
}

export const serialize = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** PIDs named by live inuse.<pid>.lock files in a session folder. */
export function liveLockPids(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.map((n) => /^inuse\.(\d+)\.lock$/.exec(n)).filter(Boolean).map((m) => Number(m[1])).filter(pidAlive);
}

/**
 * Trim a session in place (or write a trimmed copy under a new id).
 * @param {object} o
 * @param {string} o.sessionStateDir  ~/.copilot/session-state
 * @param {string} o.archiveDir       where the full log is copied first
 * @param {string} o.sessionId
 * @param {string} [o.copyTo]         new session id: write a trimmed copy, leave the source alone
 * @param {boolean} [o.dryRun]
 * @param {boolean} [o.allowLocked]   dry-run only: do not warn about a live lock (the watcher stops the host first)
 * @param {number[]} [o.knownVersions]
 * @param {{info: Function, warn: Function}} o.log
 */
export function trimSession({ sessionStateDir, archiveDir, sessionId, copyTo, dryRun = false, allowLocked = false, knownVersions = [1], log }) {
  if (!/^[\w.-]+$/.test(sessionId)) throw new Refusal(`not a session id: ${sessionId}`, 2);
  if (copyTo && !/^[\w.-]+$/.test(copyTo)) throw new Refusal(`not a session id: ${copyTo}`, 2);
  const src = path.join(sessionStateDir, sessionId);
  const file = path.join(src, 'events.jsonl');
  if (!exists(file)) throw new Refusal(`no session log at ${file}`, 2);

  if (!copyTo) {
    const live = liveLockPids(src);
    if (live.length && !dryRun) throw new Refusal(`session is in use by PID ${live.join(', ')}: stop it first`, 5);
    if (live.length && !allowLocked) log.warn(`session is in use by PID ${live.join(', ')}: a real run would refuse until it stops`);
  }
  const before = fs.statSync(file).size;
  const { events, droppedPartialLast } = parseEvents(fs.readFileSync(file, 'utf8'));
  const problems = checkSchema(events, { sessionId, knownVersions });
  if (problems.length) throw new Refusal(`refusing: the log layout is not one this kit knows:\n  - ${problems.join('\n  - ')}`, 6);
  if (droppedPartialLast) log.warn('the last line was partial and is dropped');
  const { kept, total, cut } = trimEvents(events);
  const out = serialize(kept);
  const after = Buffer.byteLength(out);
  const summary = `${total} -> ${kept.length} events, ${mib(before)} MiB -> ${mib(after)} MiB (cut at event ${cut + 1})`;

  if (dryRun) {
    log.info(`would trim ${sessionId}${copyTo ? ` into a copy ${copyTo}` : ''}: ${summary}`);
    return { sessionId, before, after, total, kept: kept.length, cut, archive: null, dryRun: true };
  }

  if (copyTo) {
    const dst = path.join(sessionStateDir, copyTo);
    if (exists(dst)) throw new Refusal(`${dst} already exists`, 2);
    fs.mkdirSync(dst);
    kept[0] = { ...kept[0], data: { ...kept[0].data, sessionId: copyTo } };
    for (const name of ['checkpoints', 'research', 'files']) {
      if (exists(path.join(src, name))) fs.cpSync(path.join(src, name), path.join(dst, name), { recursive: true });
    }
    if (exists(path.join(src, 'session.db'))) fs.copyFileSync(path.join(src, 'session.db'), path.join(dst, 'session.db'));
    if (exists(path.join(src, 'workspace.yaml'))) {
      fs.writeFileSync(path.join(dst, 'workspace.yaml'), fs.readFileSync(path.join(src, 'workspace.yaml'), 'utf8').split(sessionId).join(copyTo));
    }
    writeFileAtomic(path.join(dst, 'events.jsonl'), serialize(kept));
    log.info(`wrote trimmed copy ${copyTo}: ${summary}`);
    return { sessionId: copyTo, before, after, total, kept: kept.length, cut, archive: null };
  }

  const archDir = path.join(archiveDir, sessionId);
  fs.mkdirSync(archDir, { recursive: true, mode: 0o700 });
  const archive = path.join(archDir, `events-${stampUtc()}.jsonl`);
  fs.copyFileSync(file, archive, fs.constants.COPYFILE_EXCL);
  if (fs.statSync(archive).size !== before) throw new Error(`archive copy ${archive} is incomplete; log left untouched`);
  log.info(`archived full log: ${archive}`);
  // Re-check the log is unchanged since it was read (nothing appended while we worked).
  if (fs.statSync(file).size !== before) throw new Refusal('the log changed while trimming; left untouched', 5);
  writeFileAtomic(file, out);
  // Verify what we wrote; restore the archive if it does not read back cleanly.
  try {
    const back = parseEvents(fs.readFileSync(file, 'utf8')).events;
    const p = checkSchema(back, { sessionId, knownVersions });
    if (p.length || back.length !== kept.length) throw new Error(p.join('; ') || 'event count mismatch');
  } catch (e) {
    fs.copyFileSync(archive, file);
    throw new Error(`trimmed log failed verification (${e.message}); restored the full log`);
  }
  log.info(`trimmed ${file}: ${summary}`);
  return { sessionId, before, after, total, kept: kept.length, cut, archive };
}
