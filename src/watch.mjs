// One watcher run (the scheduler runs it every few minutes).
//
// Every run:  finds the long-lived session on the standalone host and writes the status file
//             (session id, AHP session URI, log size, trim_due).
// Resume run: when no trim is requested and the last turn died on a network error, sends a
//             continue once the model API answers again (src/resume.mjs).
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
import { maybeResume } from './resume.mjs';
import { isListening, pidAlive, processTable } from './proc.mjs';
import { checkSchema, readEvents } from './schema.mjs';
import { checkVersions, findSession, notIdleReason, readFirstEvent } from './session.mjs';
import { findCut, trimSession } from './trim.mjs';
import { exists, mib, nowIso, readJson, sleep, stampUtc, vscodeFileUri, writeJsonAtomic } from './util.mjs';

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
  const table = await processTable();
  const session = findSession(cfg, hostPid, table);
  if (!session) {
    if (request || dryRun) log.info(`no session for ${cfg.repoFolder} runs under host ${hostPid}${request ? '; trim requested but nothing done' : ''}`);
    return { state: 'no-session', hostPid };
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
  if (!request) {
    const resume = await maybeResume(cfg, log, {
      hostInfo, session, ahpSession, dryRun,
      send: (text) => sendContinue(cfg, log, ahpSession, text),
      notify: (title, body) => notify(cfg, log, title, body),
    });
    return { state: 'status', status: st, resume };
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
    return { state: 'not-idle', why };
  }

  // Safety, before anything is stopped: versions, log layout, and a usable cut point.
  const logFile = path.join(session.dir, 'events.jsonl');
  const ver = await checkVersions(cfg, { sessionStartEvent: readFirstEvent(logFile) });
  for (const n of ver.notes) log.info(n);
  let refusal = null;
  if (ver.problems.length && !force) {
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
  if (trim && up && resumed) {
    await notify(cfg, log, `Agent log trimmed and resumed (${sizes})`, 'No action needed. The agent is working again.');
  } else if (trim && up) {
    await notify(cfg, log, `Agent log trimmed (${sizes}): resume needed`, `The automatic continue failed (${lastDetail}). Open the session and send: continue from the latest handoff addendum.`);
  } else {
    await notify(cfg, log, 'Agent log trim needs attention', `Trim ok: ${!!trim}${trimError ? ` (${trimError})` : ''}. Host listening: ${up}. Resumed: ${resumed}. See ${cfg.logFile}. The session is intact either way.`);
  }
  return { state: 'trimmed', trim, trimError, up, resumed };
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
