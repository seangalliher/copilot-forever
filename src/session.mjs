// Finding the long-lived session on disk, telling whether it is idle, and version checks.
import fs from 'node:fs';
import path from 'node:path';
import { isDescendant, run } from './proc.mjs';
import { activeRepoSessions } from './host.mjs';
import { samePath } from './util.mjs';

/** The `cwd:` of a session's workspace.yaml, or null. */
export function workspaceCwd(dir) {
  let text;
  try { text = fs.readFileSync(path.join(dir, 'workspace.yaml'), 'utf8'); } catch { return null; }
  const m = /^cwd:[ \t]*(.+?)[ \t]*$/m.exec(text);
  if (!m) return null;
  let v = m[1];
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.startsWith('"') ? JSON.parse(v) : v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

/**
 * The long-lived session: a session-state folder whose workspace cwd is the repo and whose live
 * inuse.<pid>.lock PID runs under the standalone host. The largest log wins if several match.
 * @returns {{ id: string, dir: string, runtimePid: number, size: number } | null}
 */
export function findSession({ sessionStateDir, repoFolder }, hostPid, table) {
  let dirs = [];
  try { dirs = fs.readdirSync(sessionStateDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return null; }
  const found = [];
  for (const d of dirs) {
    const dir = path.join(sessionStateDir, d.name);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const m = /^inuse\.(\d+)\.lock$/.exec(n);
      if (!m) continue;
      const pid = Number(m[1]);
      if (!table.has(pid) || !isDescendant(table, pid, hostPid)) continue;
      const cwd = workspaceCwd(dir);
      if (!cwd || !samePath(cwd, repoFolder)) continue;
      let size = 0;
      try { size = fs.statSync(path.join(dir, 'events.jsonl')).size; } catch { continue; }
      found.push({ id: d.name, dir, runtimePid: pid, size });
    }
  }
  found.sort((a, b) => b.size - a.size);
  return found[0] ?? null;
}

/** Event types of the last complete lines of a file, reading backwards until `want` types are seen. */
export function lastTurnEvent(file, maxBytes = 64 * 1048576) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let pos = size;
    let carry = '';
    const chunk = 1048576;
    while (pos > 0 && size - pos < maxBytes) {
      const len = Math.min(chunk, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      const text = buf.toString('utf8') + carry;
      const lines = text.split('\n');
      carry = pos > 0 ? lines.shift() : '';
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        if (!l.includes('assistant.turn_')) continue;
        try {
          const t = JSON.parse(l).type;
          if (t === 'assistant.turn_end' || t === 'assistant.turn_start') return t;
        } catch { /* partial line */ }
      }
    }
    if (carry) {
      try {
        const t = JSON.parse(carry).type;
        if (t === 'assistant.turn_end' || t === 'assistant.turn_start') return t;
      } catch { /* ignore */ }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Why the session is not idle, or null if it is: not active on the host, log quiet for
 * `quietSeconds`, and the last turn ended.
 */
export function notIdleReason(cfg, hostInfo, session, now = Date.now()) {
  if (activeRepoSessions(hostInfo, cfg.repoFolder).length) return 'the host lists the session as active';
  const file = path.join(session.dir, 'events.jsonl');
  const age = (now - fs.statSync(file).mtimeMs) / 1000;
  if (age < cfg.watch.quietSeconds) return `the log was written ${Math.round(age)} s ago`;
  const last = lastTurnEvent(file);
  if (last !== 'assistant.turn_end') return last ? 'the last turn has not ended' : 'no turn found in the log';
  return null;
}

/**
 * A stale host status: the host lists the session as active, yet the log's last turn ended and
 * the log has been quiet for `watch.staleHostMinutes`. Returns `{ quietMinutes, logMtimeMs }`, or
 * null. During a tool call the last turn event is `assistant.turn_start` (a turn ends only after
 * its tools complete), so a long command never looks stale.
 */
export function staleHostStatus(cfg, hostInfo, session, now = Date.now()) {
  const limit = cfg.watch.staleHostMinutes;
  if (!limit || !activeRepoSessions(hostInfo, cfg.repoFolder).length) return null;
  const file = path.join(session.dir, 'events.jsonl');
  const logMtimeMs = fs.statSync(file).mtimeMs;
  const quietMinutes = (now - logMtimeMs) / 60000;
  if (quietMinutes < limit) return null;
  if (lastTurnEvent(file) !== 'assistant.turn_end') return null;
  // A turn whose last tool call is ask_user waits on an answer; Stop would abort it. A question
  // asked in plain text (then task_complete) is not detected; the notice text leaves that to you.
  if (lastTurnAsked(file)) return null;
  return { quietMinutes: Math.floor(quietMinutes), logMtimeMs };
}

/** Whether the last turn (from its `assistant.turn_start` to the end of the log) called `ask_user`. */
export function lastTurnAsked(file, maxBytes = 4 * 1048576) {
  const size = fs.statSync(file).size;
  const len = Math.min(size, maxBytes);
  const fd = fs.openSync(file, 'r');
  let text;
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    text = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('assistant.turn_start') && !l.includes('ask_user')) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'assistant.turn_start') return false;
    if (e.type === 'tool.execution_start' && e.data?.toolName === 'ask_user') return true;
  }
  return false;
}

const semver = (s) => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s ?? ''));
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), text: m[0] } : null;
};

/**
 * Copilot version checks: the `copilot` CLI on PATH (if installed) and the runtime version the
 * session's log header records. A major version outside `supportedMajors` is a problem.
 */
/** @param {any} cfg @param {{ sessionStartEvent?: any }} [opts] */
export async function checkVersions(cfg, { sessionStartEvent = undefined } = {}) {
  const problems = [];
  const notes = [];
  const majors = cfg.copilot.supportedMajors;
  const r = await run('copilot', ['--version'], { timeoutMs: 30000 });
  const cli = r.code === 0 ? semver(r.stdout) : null;
  if (!cli) notes.push('Copilot CLI not found on PATH (VS Code-only setups are fine; the log check still applies)');
  else if (!majors.includes(cli.major)) problems.push(`Copilot CLI ${cli.text} is an untested major version (tested: ${majors.join(', ')}.x)`);
  else notes.push(`Copilot CLI ${cli.text}`);
  const rtText = sessionStartEvent?.data?.copilotVersion;
  const rt = semver(rtText);
  if (rt && rt.text !== '0.0.0') {
    if (!majors.includes(rt.major)) problems.push(`the session's Copilot runtime ${rtText} is an untested major version`);
    else notes.push(`session runtime ${rtText}`);
  }
  return { cli: cli?.text ?? null, runtime: rtText ?? null, problems, notes };
}

/** Read only the first line (session.start) of a log. */
export function readFirstEvent(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const line = buf.subarray(0, n).toString('utf8').split('\n')[0];
    return JSON.parse(line);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}
