// Network resume: a turn that dies on a network error (DNS, connection refused or reset, a
// timeout, a 5xx from the model API) leaves the session idle until someone types again. When the
// session's last turn ended in such an error, the session has been quiet for a while and the
// model API answers again, the watcher sends a continue over the Agent Host Protocol.
//
// Never after auth, quota, rate-limit, policy, cancel or unrecognised errors: those need a person.
// At most `maxTries` continues per error, `retryMinutes` apart, and `maxPerDay` across all errors
// (so an API that accepts connections but fails every turn can't cause an endless loop); then
// one notification.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { notIdleReason } from './session.mjs';
import { readJson, writeJsonAtomic } from './util.mjs';

export const NETWORK_PATTERN = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|dns error|\(Connect\)|timed out|socket hang up|network is unreachable|\b50[0234]\b|Bad Gateway|Service Unavailable|Gateway Timeout/i;
export const EXCLUDE_PATTERN = /\b401\b|\b403\b|\b429\b|unauthori[sz]ed|forbidden|rate.?limit|quota|billing|content.?(filter|policy)|policy violation|cancel|abort/i;

// Event types that mean the session worked after the error (bookkeeping events don't count).
const WORK_TYPES = new Set(['assistant.turn_start', 'user.message', 'assistant.message', 'tool.execution_start']);

/** @returns {'network' | 'excluded' | 'unknown'} */
export function classifyError(message) {
  const m = String(message ?? '');
  if (EXCLUDE_PATTERN.test(m)) return 'excluded';
  return NETWORK_PATTERN.test(m) ? 'network' : 'unknown';
}

/** Parsed events of the last `maxBytes` of a log (a cut first line is dropped). */
export function tailEvents(file, maxBytes = 1048576) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift();
    return lines.flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Whether the log alone warrants a resume.
 * @returns {{ error: any, reason: string | null, quiet?: boolean }} reason null = resume; quiet = a
 *   reason that will change on its own (not worth logging every run)
 */
export function resumeCandidate(events, { now = Date.now(), quietMinutes = 15 } = {}) {
  let i = events.length - 1;
  while (i >= 0 && events[i].type !== 'session.error') i--;
  if (i < 0) return { error: null, reason: 'no error in the log tail', quiet: true };
  const error = events[i];
  if (events.slice(i + 1).some((e) => WORK_TYPES.has(e.type))) return { error, reason: 'the session has worked since the error', quiet: true };
  const kind = classifyError(error.data?.message);
  if (kind === 'excluded') return { error, reason: 'not a network error (auth, quota, rate limit, policy or cancel)' };
  if (kind === 'unknown') return { error, reason: 'not a recognised network error' };
  const age = (now - Date.parse(error.timestamp)) / 60000;
  if (!(age >= quietMinutes)) return { error, reason: `the error is only ${Math.max(0, Math.round(age))} min old`, quiet: true };
  return { error, reason: null };
}

/** The model API's host:port: from the config, else from the error text, else api.githubcopilot.com. */
export function apiTarget(cfg, message) {
  const fromMsg = /https:\/\/([^/\s:)]+)/.exec(String(message ?? ''))?.[1];
  return { host: cfg.resume.apiHost ?? fromMsg ?? 'api.githubcopilot.com', port: cfg.resume.apiPort };
}

/** Resolve and open a TCP connection; null when it connects, else why not. */
export function probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (why) => { s.destroy(); resolve(why); };
    s.setTimeout(timeoutMs, () => done(`${host}:${port} did not answer in ${timeoutMs / 1000} s`));
    s.once('connect', () => done(null));
    s.once('error', (/** @type {any} */ e) => done(`${host}:${port} is not reachable (${e.code ?? e.message})`));
  });
}

/** When the error happened, as 'YYYY-MM-DD HH:MMZ'. */
export const errorTime = (error) => new Date(error.timestamp).toISOString().slice(0, 16).replace('T', ' ') + 'Z';

export function resumeText(cfg, error) {
  const at = errorTime(error);
  const rel = path.relative(cfg.repoFolder, cfg.files.handoff).replace(/\\/g, '/');
  return cfg.resume.text.replaceAll('{time}', at).replaceAll('{handoff}', rel);
}

/**
 * One resume check, run by the watcher when no trim is requested.
 * @param {any} cfg
 * @param {import('./log.mjs').Logger} log
 * @param {{ hostInfo: any, session: any, ahpSession: string | null, dryRun?: boolean, now?: number,
 *   send: (text: string) => Promise<{ ok: boolean, detail: string }>,
 *   notify: (title: string, body: string) => Promise<unknown> }} o
 * @returns {Promise<{ state: string, [k: string]: any }>}
 */
export async function maybeResume(cfg, log, { hostInfo, session, ahpSession, dryRun = false, now = Date.now(), send, notify }) {
  const r = cfg.resume;
  if (!r.enabled) return { state: 'off' };
  const events = path.join(session.dir, 'events.jsonl');
  const c = resumeCandidate(tailEvents(events), { now, quietMinutes: r.quietMinutes });
  if (!c.error) return { state: 'none' };

  let st = null;
  try { st = readJson(cfg.resumeStateFile); } catch { /* none yet */ }
  const recent = (Array.isArray(st?.recent) ? st.recent : []).filter((t) => now - Date.parse(t) < 86400000);
  if (!st || st.error_id !== c.error.id) st = { error_id: c.error.id, tries: 0, last_try: null, gave_up: false, skip_logged: false };
  st.recent = recent;
  const save = () => { if (!dryRun) writeJsonAtomic(cfg.resumeStateFile, st); };

  if (c.reason) {
    if (!c.quiet && !st.skip_logged) {
      log.info(`network resume: not resuming after error ${c.error.id}: ${c.reason}`);
      st.skip_logged = true;
      save();
    }
    return { state: 'skip', reason: c.reason };
  }
  if (st.gave_up) return { state: 'gave-up' };
  const quietMin = (now - fs.statSync(events).mtimeMs) / 60000;
  if (quietMin < r.quietMinutes) return { state: 'wait', reason: `the log was written ${Math.round(quietMin)} min ago` };
  const busy = notIdleReason(cfg, hostInfo, session, now);
  if (busy) { log.info(`network resume: waiting (${busy})`); return { state: 'wait', reason: busy }; }
  if (st.last_try && (now - Date.parse(st.last_try)) / 60000 < r.retryMinutes) return { state: 'wait', reason: 'retry interval' };
  if (st.tries >= r.maxTries || st.recent.length >= r.maxPerDay) {
    const why = st.tries >= r.maxTries ? `${st.tries} tries for error ${c.error.id}` : `${st.recent.length} resumes in 24 hours`;
    log.warn(`network resume: gave up after ${why}; a person is needed`);
    st.gave_up = true;
    save();
    if (!dryRun) await notify('Agent stopped on a network error: resume needed', `Automatic continue gave up after ${why}. Open the session and send: continue. See ${cfg.logFile}.`);
    return { state: 'gave-up' };
  }
  const t = apiTarget(cfg, c.error.data?.message);
  const down = await probe(t.host, t.port, r.probeTimeoutSeconds * 1000);
  if (down) { log.info(`network resume: the model API is still down (${down}); will check again next run`); return { state: 'api-down', reason: down }; }
  if (!ahpSession) { log.warn('network resume: no AHP session URI known; cannot send continue'); return { state: 'no-ahp' }; }

  st.tries += 1;
  st.last_try = new Date(now).toISOString();
  st.recent.push(st.last_try);
  const text = resumeText(cfg, c.error);
  if (dryRun) {
    log.info(`network resume: would send continue (try ${st.tries}) after error ${c.error.id}`);
    return { state: 'would-resume', text };
  }
  save();
  const res = await send(text);
  log.info(`network resume try ${st.tries}: ${res.ok ? 'ok' : 'failed'}: ${res.detail}`);
  if (res.ok) await notify('Agent resumed after a network error', `It stopped at ${errorTime(c.error)}. No action needed.`);
  return { state: res.ok ? 'resumed' : 'resume-failed', tries: st.tries };
}
