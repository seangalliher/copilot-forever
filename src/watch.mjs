// One watcher run (the scheduler runs it every few minutes).
//
// Every run:  retries a continue an earlier trim could not deliver (pending continue), then finds
//             the long-lived session on the standalone host and writes the status file
//             (session id, AHP session URI, log size, trim_due).
// Resume run: when no trim is requested and the last turn died on a network error, sends a
//             continue once the model API answers again; and when the last turn ended waiting on
//             background work whose completion never woke it (src/resume.mjs, stall resume).
// Trim run:   only when the agent has written the request file at a safe point and stopped.
//             If the session is idle on two checks apart, it stops the host, trims the log
//             (archiving the full log first), restarts the host, sends the continue message over
//             the Agent Host Protocol and notifies.
// --dry-run:  every check runs; nothing is written, stopped, trimmed, started or sent.
import fs from 'node:fs';
import path from 'node:path';
import { continueSession, connect, findSessionUri } from './ahp.mjs';
import { continueMessage } from './config.mjs';
import { agentPs, activeRepoSessions, findStandaloneHost, readToken, startHost, stopHost } from './host.mjs';
import { notify } from './notify.mjs';
import { maybeResume, maybeStallResume } from './resume.mjs';
import { isListening, pidAlive, processTable } from './proc.mjs';
import { checkSchema, readEvents } from './schema.mjs';
import { checkVersions, findSession, notIdleReason, readFirstEvent, sharedSessions, staleHostStatus } from './session.mjs';
import { findCut, trimSession } from './trim.mjs';
import { exists, mib, nowIso, readJson, samePath, sleep, stampUtc, vscodeFileUri, writeJsonAtomic } from './util.mjs';

/** Take the single-run lock; returns a release function, or null if another live run holds it. */
export function takeLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return () => { try { fs.unlinkSync(file); } catch { /* gone */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = Number(fs.readFileSync(file, 'utf8').trim());
      if (pidAlive(holder) && holder !== process.pid) return null;
      fs.unlinkSync(file); // stale
    }
  }
  return null;
}

/**
 * Notify once per stale episode (keyed by the log's mtime) when the host still lists the session
 * as running although its last turn ended long ago. A stale status blocks trims and resumes, and
 * the watcher never overrides the host, so a person has to clear it (Stop in the chat).
 * Seen on a real host: a requested trim waited over 2 hours on one.
 */
export async function maybeNotifyStale(cfg, log, { hostInfo, session, dryRun = false, requested = false, notify: send, now = Date.now() }) {
  const stale = staleHostStatus(cfg, hostInfo, session, now);
  if (!stale) return { state: 'ok' };
  const key = new Date(stale.logMtimeMs).toISOString();
  try { if (readJson(cfg.staleStateFile).log_mtime === key) return { state: 'already-notified', ...stale }; } catch { /* none yet */ }
  log.warn(`stale host status: the host lists the session as running, but its last turn ended and the log has been quiet ${stale.quietMinutes} min`);
  if (dryRun) return { state: 'would-notify', ...stale };
  writeJsonAtomic(cfg.staleStateFile, { log_mtime: key, notified_at: nowIso() });
  await send('Agent host status stuck', `The host still lists the session as running, but its last turn ended ${stale.quietMinutes} min ago. ${requested ? 'A requested log trim is waiting on it. ' : ''}Open the chat. If it shows as running with no question or background work pending, press Stop.`);
  return { state: 'notified', ...stale };
}

export function statusObject(cfg, session, ahpSession, sizeBytes) {
  const size = mib(sizeBytes);
  const rel = (p) => path.relative(cfg.repoFolder, p).replace(/\\/g, '/');
  return {
    session_id: session.id,
    ahp_session: ahpSession ?? null,
    size_mib: size,
    threshold_mib: cfg.trim.thresholdMiB,
    trim_due: sizeBytes >= cfg.trim.thresholdMiB * 1048576,
    checked_at: nowIso(),
    how_to_request: `At a safe point with nothing running: write the handoff addendum to ${rel(cfg.files.handoff)}, write ${rel(cfg.files.request)}, then stop (end your turn).`,
  };
}

function readRequest(cfg, log) {
  if (!exists(cfg.files.request)) return null;
  try {
    const r = readJson(cfg.files.request);
    return r && typeof r === 'object' ? r : {};
  } catch (e) {
    log.warn(`request file ${cfg.files.request} is not valid JSON (${e.message}); treating it as a request anyway`);
    return {};
  }
}

/**
 * @param {object} cfg resolved config
 * @param {import('./log.mjs').Logger} log
 * @param {{ dryRun?: boolean, force?: boolean }} opts force: trim on request even if versions are untested
 * @returns {Promise<{ state: string, [k: string]: any }>}
 */
/**
 * Notify once per episode when a session is open both in this host and in another runtime (see
 * `sharedSessions`). The watcher changes nothing about it; a trim of such a session is refused.
 */
export async function maybeNotifyShared(cfg, log, { shared, dryRun = false, notify: send }) {
  if (!shared.length) return { state: 'ok' };
  const key = shared.map((s) => `${s.id}:${[...s.here, ...s.elsewhere].sort((a, b) => a - b).join(',')}`).sort().join(';');
  try { if (readJson(cfg.sharedStateFile).key === key) return { state: 'already-notified', shared }; } catch { /* none yet */ }
  const where = (s) => `runtime ${s.elsewhere.join(', ')}${s.elsewhereHosts?.length ? ` under ${s.elsewhereHosts.join(', ')}` : ''}`;
  const lines = shared.map((s) => `session ${s.id} (${s.cwd ?? 'unknown folder'}): runtime ${s.here.join(', ')} under this host, ${where(s)} elsewhere`);
  log.warn(`session open in two runtimes: ${lines.join('; ')}`);
  if (dryRun) return { state: 'would-notify', shared };
  writeJsonAtomic(cfg.sharedStateFile, { key, notified_at: nowIso() });
  await send('Session open in two hosts', `${sharedAdvice(cfg, shared[0], where(shared[0]))}${shared.length > 1 ? ` (${shared.length - 1} more such sessions in the log.)` : ''}`);
  return { state: 'notified', shared };
}

/**
 * Which copy to close. This repository's session belongs to this host, so the other copy is the
 * mistake; another folder's session belongs to its own host, so the copy in this host is.
 */
export function sharedAdvice(cfg, s, where) {
  const risk = 'Two runtimes writing one log can lose work, and trims of it are refused.';
  if (!s.cwd) {
    return `Session ${s.id} (folder unknown) is open in this host (localhost:${cfg.host.port}) and in ${where}. ${risk} Find which chat you opened by mistake and stop any turn in it; check before restarting either host.`;
  }
  if (samePath(s.cwd, cfg.repoFolder)) {
    return `Your session ${s.id} is also open in ${where}. ${risk} Close that copy: stop any turn in its chat, then restart that host.`;
  }
  return `Session ${s.id} (${s.cwd ?? 'another folder'}) is open in this host (localhost:${cfg.host.port}) and in ${where}. ${risk} The copy in this host is probably the mistake: stop any turn in its chat, then restart this host (copilot-forever host stop, then host start) while your own session is idle.`;
}

export async function watchOnce(cfg, log, { dryRun = false, force = false } = {}) {
  const release = dryRun ? () => {} : takeLock(cfg.lockFile);
  if (!release) {
    log.info('another watcher run is in progress; skipping');
    return { state: 'locked' };
  }
  try {
    return await watchInner(cfg, log, { dryRun, force });
  } finally {
    release();
  }
}

async function watchInner(cfg, log, { dryRun, force }) {
  // ---- every run: status file -------------------------------------------------------------
  let hosts;
  try {
    hosts = await agentPs(cfg);
  } catch (e) {
    log.warn(e.message);
    hosts = [];
  }
  let hostInfo = findStandaloneHost(hosts, cfg.host.port);
  const request = readRequest(cfg, log);
  if (!hostInfo) {
    if (request) log.info(`trim requested but no standalone host on port ${cfg.host.port} is running; nothing done`);
    else if (dryRun) log.info(`no standalone host on port ${cfg.host.port}`);
    return { state: 'no-host' };
  }
  const hostPid = Number(hostInfo.host.pid);
  // Before the session lookup: after a host restart the trimmed session holds no runtime lock until
  // a message loads it, so findSession finds nothing until the owed continue goes through.
  let pending;
  try {
    pending = await maybePendingContinue(cfg, log, {
      dryRun,
      listening: () => isListening(cfg.host.port),
      send: (uri, text) => sendContinue(cfg, log, uri, text),
      notify: (title, body) => notify(cfg, log, title, body),
    });
  } catch (e) {
    log.warn(`pending continue check failed: ${e.message}`);
    pending = { state: 'error' };
  }
  const table = await processTable();
  let shared;
  try {
    shared = await maybeNotifyShared(cfg, log, { shared: sharedSessions(cfg, hostPid, table, hosts), dryRun, notify: (title, body) => notify(cfg, log, title, body) });
  } catch (e) {
    log.warn(`shared session check failed: ${e.message}`);
    shared = { state: 'error' };
  }
  const session = findSession(cfg, hostPid, table);
  if (!session) {
    if (request || dryRun) log.info(`no session for ${cfg.repoFolder} runs under host ${hostPid}${request ? '; trim requested but nothing done' : ''}`);
    return { state: 'no-session', hostPid, shared, pending };
  }

  // The AHP session URI differs from the Copilot session id. Taken from the host's active listing
  // while the agent works, else carried over from the last status file, else asked over AHP.
  const active = activeRepoSessions(hostInfo, cfg.repoFolder);
  let ahpSession = active.length === 1 ? active[0].resource : null;
  if (!ahpSession) {
    try {
      const prev = readJson(cfg.files.status);
      if (prev.session_id === session.id) ahpSession = prev.ahp_session;
    } catch { /* no status yet */ }
  }
  if (!ahpSession) {
    try {
      const { client } = await connect({ port: cfg.host.port, token: readToken(cfg) });
      ahpSession = await findSessionUri(client, cfg.repoFolder);
      await client.shutdown();
    } catch (e) {
      log.warn(`could not look up the AHP session URI: ${e.message}`);
    }
  }
  const st = statusObject(cfg, session, ahpSession, session.size);
  if (dryRun) log.info(`status would be: ${JSON.stringify(st)}`);
  else writeJsonAtomic(cfg.files.status, st);
  let stale;
  try {
    stale = await maybeNotifyStale(cfg, log, { hostInfo, session, dryRun, requested: !!request, notify: (title, body) => notify(cfg, log, title, body) });
  } catch (e) {
    log.warn(`stale host check failed: ${e.message}`);
    stale = { state: 'error' };
  }
  if (!request) {
    const io = {
      hostInfo, session, ahpSession, dryRun,
      send: (text) => sendContinue(cfg, log, ahpSession, text),
      notify: (title, body) => notify(cfg, log, title, body),
    };
    const resume = await maybeResume(cfg, log, io);
    // A network resume this run already sent a continue (or is waiting on one); check stalls next run.
    const stall = ['resumed', 'resume-failed', 'would-resume'].includes(resume.state) ? { state: 'skipped' } : await maybeStallResume(cfg, log, io);
    return { state: 'status', status: st, resume, stall, stale, shared, pending };
  }

  // ---- trim run ------------------------------------------------------------------------------
  log.info(`trim requested for ${session.id} (${st.size_mib} MiB, runtime ${session.runtimePid}, host ${hostPid})`);
  if (request.session_id && request.session_id !== session.id) {
    log.warn(`the request names session ${request.session_id}, but the running session is ${session.id}; not trimming`);
    await notify(cfg, log, 'copilot-forever: trim request mismatch', `The request names ${request.session_id}; the running session is ${session.id}. Nothing done.`, { dryRun });
    if (!dryRun) archiveRequest(cfg, 'mismatch');
    return { state: 'request-mismatch' };
  }

  let why = notIdleReason(cfg, hostInfo, session);
  if (!why) {
    if (!dryRun) await sleep(cfg.watch.idleRecheckSeconds * 1000);
    try { hostInfo = findStandaloneHost(await agentPs(cfg), cfg.host.port) ?? hostInfo; } catch { /* keep the first listing */ }
    why = notIdleReason(cfg, hostInfo, session);
  }
  if (why) {
    log.info(`not idle yet (${why}); will check again next run`);
    return { state: 'not-idle', why, stale, shared };
  }

  // Safety, before anything is stopped: versions, log layout, and a usable cut point.
  const logFile = path.join(session.dir, 'events.jsonl');
  const ver = await checkVersions(cfg, { sessionStartEvent: readFirstEvent(logFile) });
  for (const n of ver.notes) log.info(n);
  let refusal = null;
  const other = sharedSessions(cfg, hostPid, await processTable(), hosts).find((x) => x.id === session.id);
  if (other) {
    refusal = `the session is also open in another runtime (pid ${other.elsewhere.join(', ')}${other.elsewhereHosts.length ? ` under ${other.elsewhereHosts.join(', ')}` : ''}), which still has its log open; close that copy, then request the trim again`;
  } else if (ver.problems.length && !force) {
    refusal = `untested Copilot version: ${ver.problems.join('; ')} (run \`copilot-forever trim <id> --force\` by hand to accept the risk)`;
  } else {
    try {
      const { events } = readEvents(logFile);
      const problems = checkSchema(events, { sessionId: session.id, knownVersions: cfg.copilot.knownLogVersions });
      if (problems.length) refusal = `unknown log layout: ${problems.join('; ')}`;
      else {
        const { cut, reason } = findCut(events);
        if (cut === null) refusal = reason;
      }
    } catch (e) {
      refusal = `cannot read the log: ${e.message}`;
    }
  }
  if (refusal) {
    log.error(`refusing to trim: ${refusal}`);
    if (dryRun) {
      log.info('would archive the request, send a continue saying the trim did not happen, and notify');
      return { state: 'would-refuse', refusal };
    }
    archiveRequest(cfg, 'refused');
    const r = ahpSession ? await sendContinue(cfg, log, ahpSession, `${continueMessage(cfg)} Note: the log trim did NOT happen (${refusal}); nothing was changed.`) : { ok: false, detail: 'no AHP session URI known' };
    await notify(cfg, log, 'copilot-forever: trim refused', `${refusal}. Nothing was stopped or changed. ${r.ok ? 'The agent was told to continue.' : `Send it "continue" yourself (${r.detail}).`}`);
    return { state: 'refused', refusal, resumed: r.ok };
  }

  if (dryRun) {
    trimSession({ ...trimArgs(cfg, session.id), dryRun: true, allowLocked: true, log });
    log.info(`would stop host ${hostPid}, trim ${session.id}, restart the host, send continue to ${ahpSession ?? '(unknown AHP session)'} and notify`);
    return { state: 'would-trim', status: st };
  }

  await stopHost(cfg, hostPid, log, { runtimePid: session.runtimePid });

  let trim = null;
  let trimError = null;
  try {
    trim = trimSession({ ...trimArgs(cfg, session.id), log });
  } catch (e) {
    trimError = e.message;
    log.error(`trim FAILED: ${e.message}`);
  }

  log.info('starting host');
  let up = false;
  try {
    up = await startHost(cfg, log);
  } catch (e) {
    log.error(`host start failed: ${e.message}`);
  }
  if (!up) up = await isListening(cfg.host.port);

  archiveRequest(cfg, trim ? '' : 'failed');
  if (trim) {
    // Rewrite at once so the resumed agent never reads a stale trim_due = true.
    writeJsonAtomic(cfg.files.status, statusObject(cfg, session, ahpSession, trim.after));
  }

  let resumed = false;
  let lastDetail = '';
  if (up && ahpSession) {
    await sleep(cfg.watch.continueDelaySeconds * 1000);
    const text = trim ? continueMessage(cfg) : `${continueMessage(cfg)} Note: the log trim failed (${trimError}); the full log is intact.`;
    const r = await sendContinue(cfg, log, ahpSession, text);
    resumed = r.ok;
    lastDetail = r.detail;
  } else if (up) {
    lastDetail = 'no AHP session URI known';
    log.warn(`${lastDetail}; cannot send continue`);
  }

  const sizes = trim ? `${mib(trim.before)} -> ${mib(trim.after)} MiB` : '';
  // A continue still owed after a successful trim: later runs retry it (maybePendingContinue).
  const owed = trim && !resumed && ahpSession
    ? recordPendingContinue(cfg, log, { ahpSession, sessionDir: session.dir, trimmedAt: nowIso() })
    : null;
  const retry = `It will be retried on the next ${cfg.watch.pendingContinueMaxTries} watcher runs; to resume now, open the session and send: continue from the latest handoff addendum.`;
  if (trim && up && resumed) {
    await notify(cfg, log, `Agent log trimmed and resumed (${sizes})`, 'No action needed. The agent is working again.');
  } else if (owed) {
    await notify(cfg, log, `Agent log trimmed (${sizes}): continue pending`, `The automatic continue did not go through (${up ? lastDetail : 'the host is not listening'}). ${retry}`);
  } else if (trim && up) {
    await notify(cfg, log, `Agent log trimmed (${sizes}): resume needed`, `The automatic continue failed (${lastDetail}). Open the session and send: continue from the latest handoff addendum.`);
  } else {
    await notify(cfg, log, 'Agent log trim needs attention', `Trim ok: ${!!trim}${trimError ? ` (${trimError})` : ''}. Host listening: ${up}. Resumed: ${resumed}. See ${cfg.logFile}. The session is intact either way.`);
  }
  return { state: 'trimmed', trim, trimError, up, resumed, pending, owed: !!owed };
}

// ---- pending continue after a trim ------------------------------------------------------------
// A trim stops the session deliberately, so neither network nor stall resume applies to it, and
// after the host restarts the session holds no runtime lock until a message loads it. When the trim
// run cannot deliver its continue, it records one as owed, and every later run retries it before
// the session lookup. Seen on a real machine with the same design: the host check failed after a
// trim, no continue was sent, and the agent sat idle for 22 hours.

const logMtime = (sessionDir) => {
  try { return fs.statSync(path.join(sessionDir, 'events.jsonl')).mtimeMs; } catch { return null; }
};

/** Record that the trim's continue is still owed. The log's mtime, taken now, tells later runs whether anyone resumed the session since. */
export function recordPendingContinue(cfg, log, { ahpSession, sessionDir, trimmedAt }) {
  const p = { ahp_session: ahpSession, session_dir: sessionDir, trimmed_at: trimmedAt, log_mtime_ms: logMtime(sessionDir), tries: 0, gave_up: false };
  writeJsonAtomic(cfg.pendingContinueFile, p);
  log.warn(`the continue after the trim was not delivered; recorded it in ${cfg.pendingContinueFile} for the next runs`);
  return p;
}

export function pendingText(cfg, trimmedAt) {
  const rel = path.relative(cfg.repoFolder, cfg.files.handoff).replace(/\\/g, '/');
  return `Continue. Your session log was trimmed at ${trimmedAt} after you stopped for a log trim, and the automatic continue only went through now. Resume from the latest addendum in ${rel}, and check git state and any work that was running before you act.`;
}

/**
 * One retry of an owed continue (see recordPendingContinue). Clears it when the log shows the
 * session worked since (resumed by hand) or when the continue goes through; after
 * watch.pendingContinueMaxTries tries, notifies once and stops trying.
 * @param {{ dryRun?: boolean, listening: () => Promise<boolean>, send: (uri: string, text: string) => Promise<{ ok: boolean, detail: string }>, notify: (title: string, body: string) => Promise<any> }} io
 */
export async function maybePendingContinue(cfg, log, { dryRun = false, listening, send, notify: tell }) {
  const file = cfg.pendingContinueFile;
  if (!exists(file)) return { state: 'none' };
  const drop = () => { if (!dryRun) fs.rmSync(file, { force: true }); };
  let p = null;
  try { p = readJson(file); } catch { /* handled below */ }
  if (!p || typeof p.ahp_session !== 'string' || typeof p.session_dir !== 'string') {
    log.warn(`pending continue: ${file} is unreadable; ${dryRun ? 'would remove' : 'removing'} it`);
    drop();
    return { state: 'unreadable' };
  }
  const mtime = logMtime(p.session_dir);
  if (mtime !== null && mtime !== p.log_mtime_ms) {
    log.info(`pending continue: the session log has changed since the trim at ${p.trimmed_at} (resumed by hand); ${dryRun ? 'would clear' : 'clearing'} it`);
    drop();
    return { state: 'cleared' };
  }
  if (p.gave_up) return { state: 'gave-up' };
  if (!(await listening())) {
    log.info('pending continue: the host is not listening; will try again next run');
    return { state: 'host-down' };
  }
  const max = cfg.watch.pendingContinueMaxTries;
  const tries = Number(p.tries) || 0;
  if (tries >= max) {
    log.warn(`pending continue: gave up after ${tries} tries`);
    if (dryRun) return { state: 'would-give-up', tries };
    writeJsonAtomic(file, { ...p, gave_up: true });
    await tell('Agent log trimmed: resume needed', `The automatic continue after the ${p.trimmed_at} trim failed on ${tries} later tries. Open the session and send: continue from the latest handoff addendum. See ${cfg.logFile}.`);
    return { state: 'gave-up-now', tries };
  }
  if (dryRun) {
    log.info(`pending continue: would send continue (try ${tries + 1} of ${max}) to ${p.ahp_session}`);
    return { state: 'would-send', tries };
  }
  writeJsonAtomic(file, { ...p, tries: tries + 1, last_try: nowIso() });
  const r = await send(p.ahp_session, pendingText(cfg, p.trimmed_at));
  log.info(`pending continue try ${tries + 1}: ${r.ok ? 'ok' : 'failed'}: ${r.detail}`);
  if (!r.ok) {
    // A failed attempt can still load the session and write to its log; that is not a hand resume.
    writeJsonAtomic(file, { ...p, tries: tries + 1, last_try: nowIso(), log_mtime_ms: logMtime(p.session_dir) });
    return { state: 'failed', tries: tries + 1 };
  }
  fs.rmSync(file, { force: true });
  await tell('Agent resumed after its log trim', `The continue after the ${p.trimmed_at} trim went through on a later try. No action needed.`);
  return { state: 'resumed', tries: tries + 1 };
}

function archiveRequest(cfg, tag) {
  fs.mkdirSync(cfg.files.history, { recursive: true });
  const name = `trim-request-${stampUtc()}${tag ? `-${tag}` : ''}.json`;
  try { fs.renameSync(cfg.files.request, path.join(cfg.files.history, name)); } catch { /* already gone */ }
}

/** Send the continue message, with retries. */
async function sendContinue(cfg, log, ahpSession, text) {
  let r = { ok: false, detail: '' };
  for (let t = 1; t <= cfg.watch.continueTries; t++) {
    try {
      r = await continueSession({
        port: cfg.host.port, token: readToken(cfg), sessionUri: ahpSession, text, log,
        timeoutMs: cfg.watch.continueTimeoutSeconds * 1000,
        expectAgent: path.basename(cfg.agentFile), agentUri: vscodeFileUri(cfg.agentFile),
      });
    } catch (e) {
      r = { ok: false, detail: e.message };
    }
    log.info(`continue try ${t}: ${r.ok ? 'ok' : 'failed'}: ${r.detail}`);
    if (r.ok) break;
    if (t < cfg.watch.continueTries) await sleep(cfg.watch.continueRetrySeconds * 1000);
  }
  return r;
}

const trimArgs = (cfg, sessionId) => ({
  sessionStateDir: cfg.sessionStateDir,
  archiveDir: cfg.trim.archiveDir,
  sessionId,
  knownVersions: cfg.copilot.knownLogVersions,
});
