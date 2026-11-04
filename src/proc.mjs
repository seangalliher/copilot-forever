// Process and port helpers, cross-platform.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { isWindows, sleep, sys32 } from './util.mjs';

/**
 * Run a command and collect its output. Never throws for a non-zero exit.
 * On Windows a `.cmd`/`.bat` file (e.g. VS Code's `code.cmd`) runs through cmd.exe.
 * @param {string} cmd
 * @param {string[]} [args]
 * @param {{ timeoutMs?: number, env?: NodeJS.ProcessEnv, cwd?: string, input?: string }} [opts]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, error?: Error}>}
 */
export function run(cmd, args = [], { timeoutMs = 60000, env = undefined, cwd = undefined, input = undefined } = {}) {
  const [file, fileArgs, opts] = winWrap(cmd, args);
  return new Promise((resolve) => {
    const child = execFile(file, fileArgs, { timeout: timeoutMs, env, cwd, windowsHide: true, maxBuffer: 64 * 1048576, ...opts },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr), error: error && code === null ? error : undefined });
      });
    if (input !== undefined) child.stdin.end(input);
  });
}

const cmdQuote = (a) => (/^[\w./:\\=@%+,-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '""')}"`);

/** On Windows, find `code` → `code.cmd` and wrap batch files in cmd.exe; elsewhere pass through. */
export function winWrap(cmd, args) {
  if (!isWindows) return [cmd, args, {}];
  const resolved = whichSync(cmd) ?? cmd;
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const line = [resolved, ...args].map(cmdQuote).join(' ');
    return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true }];
  }
  return [resolved, args, {}];
}

/** Locate an executable on PATH (with PATHEXT on Windows). Returns null if not found. */
export function whichSync(cmd) {
  if (cmd.includes('/') || cmd.includes('\\')) return fs.existsSync(cmd) ? cmd : null;
  const dirs = (process.env.PATH || process.env.Path || '').split(isWindows ? ';' : ':').filter(Boolean);
  // On Windows only PATHEXT names are runnable (npm also installs an extensionless sh script).
  const exts = isWindows && !/\.[a-z0-9]+$/i.test(cmd) ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const p = `${d}${isWindows ? '\\' : '/'}${cmd}${e}`;
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch { /* next */ }
    }
  }
  return null;
}

/** True if a process with this PID exists. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Snapshot of all processes: Map pid -> { ppid, exe }.
 * Windows: one CIM query through PowerShell. macOS/Linux: `ps`.
 */
export async function processTable() {
  const table = new Map();
  if (isWindows) {
    const ps = 'Get-CimInstance Win32_Process | ForEach-Object { "{0}`t{1}`t{2}" -f $_.ProcessId, $_.ParentProcessId, $_.ExecutablePath }';
    const r = await run(sys32('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 60000 });
    for (const line of r.stdout.split(/\r?\n/)) {
      const [pid, ppid, exe] = line.split('\t');
      if (/^\d+$/.test(pid ?? '')) table.set(Number(pid), { ppid: Number(ppid), exe: exe || '' });
    }
  } else {
    const r = await run('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'comm='], { timeoutMs: 30000 });
    for (const line of r.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) table.set(Number(m[1]), { ppid: Number(m[2]), exe: m[3].trim() });
    }
  }
  return table;
}

/** True if `pid` is `ancestor` or one of its descendants (follows at most 32 parents). */
export function isDescendant(table, pid, ancestor) {
  let p = pid;
  for (let i = 0; i < 32 && p; i++) {
    if (p === ancestor) return true;
    const e = table.get(p);
    if (!e || e.ppid === p) return false;
    p = e.ppid;
  }
  return false;
}

/** All descendants of `pid`, deepest first. */
export function descendants(table, pid) {
  const kids = new Map();
  for (const [p, e] of table) {
    if (!kids.has(e.ppid)) kids.set(e.ppid, []);
    kids.get(e.ppid).push(p);
  }
  const out = [];
  const walk = (p, depth) => {
    if (depth > 32) return;
    for (const c of kids.get(p) ?? []) {
      if (c === p) continue;
      walk(c, depth + 1);
      out.push(c);
    }
  };
  walk(pid, 0);
  return out;
}

/** Kill a process and everything under it. Windows: taskkill /T /F. Unix: TERM, then KILL after 5 s. */
export async function killTree(pid) {
  if (!pidAlive(pid)) return true;
  if (isWindows) {
    await run(sys32('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { timeoutMs: 60000 });
  } else {
    const all = [...descendants(await processTable(), pid), pid];
    for (const p of all) {
      try { process.kill(p, 'SIGTERM'); } catch { /* gone */ }
    }
    for (let i = 0; i < 10 && all.some(pidAlive); i++) await sleep(500);
    for (const p of all) {
      if (pidAlive(p)) {
        try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
      }
    }
  }
  for (let i = 0; i < 20 && pidAlive(pid); i++) await sleep(250);
  return !pidAlive(pid);
}

/** True if something accepts TCP connections on localhost:port (IPv4 or IPv6 loopback). */
export async function isListening(port, timeoutMs = 1500) {
  const tryHost = (host) => new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
  return (await tryHost('127.0.0.1')) || (await tryHost('::1'));
}

/** Start a detached background process whose output goes to `logFd`. Returns its PID. */
export function spawnDetached(cmd, args, { env, cwd, logFd }) {
  const [file, fileArgs, opts] = winWrap(cmd, args);
  const child = spawn(file, fileArgs, {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
    env,
    cwd,
    ...opts,
  });
  child.unref();
  return child.pid;
}
