// The standalone VS Code agent host: token, clean environment, start, stop, discovery.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addSecret, redact } from './log.mjs';
import { isListening, killTree, pidAlive, run, spawnDetached, winWrap } from './proc.mjs';
import { exists, isWindows, sys32, readJson, Refusal, samePath, sleep, uriToPath, waitFor } from './util.mjs';

// Variables a GUI-less `code agent host` needs. Everything else (shell, IDE, other agents'
// variables such as CLAUDECODE, VSCODE_*, ELECTRON_RUN_AS_NODE, NODE_OPTIONS) is dropped, so
// nothing from whoever ran this command leaks into the long-lived agent's shells.
const ENV_ALLOW = {
  win32: ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'Path', 'PATH', 'USERPROFILE', 'USERNAME',
    'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles',
    'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
    'TEMP', 'TMP', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS', 'COMPUTERNAME', 'PUBLIC',
    'ALLUSERSPROFILE', 'PSModulePath', 'DriverData'],
  posix: ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'LANG', 'LANGUAGE', 'TMPDIR', 'TZ', 'DISPLAY',
    'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK'],
};

/** A minimal environment for the host: the allowlist, LC_* / XDG_*, and config `host.passEnv`. */
export function cleanEnv(cfg, source = process.env) {
  const allow = new Set([...(isWindows ? ENV_ALLOW.win32 : ENV_ALLOW.posix), ...(cfg.host.passEnv ?? [])]);
  const env = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    const keep = isWindows
      ? [...allow].some((a) => a.toLowerCase() === k.toLowerCase())
      : allow.has(k) || /^LC_/.test(k) || /^XDG_/.test(k);
    if (keep) env[k] = v;
  }
  return env;
}

/** Restrict a file to its owner: chmod 600, and on Windows an ACL with only the current user. */
export async function makeOwnerOnly(file) {
  if (!isWindows) {
    fs.chmodSync(file, 0o600);
    return;
  }
  const who = await run(sys32('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
  const sid = /"(S-1-[\d-]+)"/.exec(who.stdout)?.[1];
  if (!sid) throw new Error('cannot determine the current user SID for the token ACL');
  const r = await run(sys32('icacls.exe'), [file, '/inheritance:r', '/grant:r', `*${sid}:F`]);
  if (r.code !== 0) throw new Error(`icacls failed: ${r.stderr || r.stdout}`);
}

/** Create the token file if missing. Never prints the token. Returns the token. */
export async function ensureToken(cfg, log, { dryRun = false } = {}) {
  const f = cfg.host.tokenFile;
  if (exists(f)) {
    const t = fs.readFileSync(f, 'utf8').trim();
    if (!t) throw new Refusal(`token file ${f} is empty`);
    addSecret(t);
    if (!isWindows && (fs.statSync(f).mode & 0o077)) log.warn(`token file ${f} is readable by others; run: chmod 600 "${f}"`);
    return t;
  }
  if (dryRun) {
    log.info(`would create token file ${f} (owner-only)`);
    return null;
  }
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const t = randomBytes(32).toString('hex');
  addSecret(t);
  fs.writeFileSync(f, t, { mode: 0o600, flag: 'wx' });
  await makeOwnerOnly(f);
  log.info(`created token file ${f} (owner-only)`);
  return t;
}

export function readToken(cfg) {
  const t = fs.readFileSync(cfg.host.tokenFile, 'utf8').trim();
  addSecret(t);
  return t;
}

export function hostArgs(cfg) {
  return ['agent', 'host', '--host', 'localhost', '--port', String(cfg.host.port),
    '--connection-token-file', cfg.host.tokenFile, '--new-instance'];
}

/**
 * `code agent ps --json`: the hosts on this machine and their active sessions.
 * @returns {Promise<Array<{host: {type: string, pid: number, address: string}, sessions: any[]}>>}
 */
export async function agentPs(cfg) {
  const [cmd, ...lead] = cfg.host.codeCommand;
  const r = await run(cmd, [...lead, 'agent', 'ps', '--json'], { timeoutMs: 60000 });
  if (r.code !== 0) throw new Error(`\`${cmd} agent ps --json\` failed (exit ${r.code}): ${redact((r.stderr || r.error?.message || '').trim())}`);
  try {
    const j = JSON.parse(r.stdout);
    return Array.isArray(j) ? j : [];
  } catch {
    throw new Error(`\`${cmd} agent ps --json\` printed something that is not JSON`);
  }
}

/** This kit's standalone host (type standalone, bound to our port), or null. */
export function findStandaloneHost(hosts, port) {
  return hosts.find((h) => h?.host?.type === 'standalone' && String(h.host.address ?? '').endsWith(`:${port}`)) ?? null;
}

/** The host's active sessions that work in `repoFolder`. */
export function activeRepoSessions(hostInfo, repoFolder) {
  return (hostInfo?.sessions ?? []).filter((s) => (s.workingDirectories ?? []).some((w) => samePath(uriToPath(w), repoFolder)));
}

/** Overwrite connection tokens in a log file with same-length masks, in place (no offset shift). */
export function maskTokenInFile(file, token) {
  if (!exists(file)) return;
  const buf = fs.readFileSync(file);
  let s = buf.toString('latin1');
  const before = s;
  s = s.replace(/tkn=([0-9A-Za-z%_-]+)/g, (_m, v) => 'tkn=' + '*'.repeat(v.length));
  if (token) s = s.split(token).join('*'.repeat(token.length));
  if (s === before) return;
  const fd = fs.openSync(file, 'r+');
  try { fs.writeSync(fd, Buffer.from(s, 'latin1'), 0, buf.length, 0); } finally { fs.closeSync(fd); }
}

function installed(cfg) {
  try { return readJson(cfg.installMarker); } catch { return null; }
}

/**
 * Start the host unless it is already listening.
 * - foreground: run the host as a child and stay until the port closes (systemd/launchd service mode).
 * - otherwise: through the installed OS service when startVia is 'auto' and `install` ran, else spawn
 *   detached with a clean environment, then wait for the port.
 */
/** @param {any} cfg @param {any} log @param {{ dryRun?: boolean, foreground?: boolean, viaService?: boolean }} [opts] */
export async function startHost(cfg, log, { dryRun = false, foreground = false, viaService = undefined } = {}) {
  const port = cfg.host.port;
  if (await isListening(port)) {
    log.info(`port ${port} already listening; nothing to do`);
    return true;
  }
  const token = await ensureToken(cfg, log, { dryRun });
  const [cmd, ...lead] = cfg.host.codeCommand;
  const args = [...lead, ...hostArgs(cfg)];
  const marker = installed(cfg);
  const useService = viaService ?? (!foreground && cfg.host.startVia === 'auto' && marker?.hostService);
  if (dryRun) {
    log.info(useService
      ? `would start the host through ${marker.hostService.kind} ${marker.hostService.name}`
      : `would run (clean env, cwd ${cfg.repoFolder}): ${cmd} ${args.join(' ')}`);
    return true;
  }
  if (!exists(cfg.repoFolder)) throw new Refusal(`repoFolder ${cfg.repoFolder} does not exist`);
  fs.mkdirSync(path.dirname(cfg.hostLogFile), { recursive: true });

  if (useService) {
    const { startService } = await import('./install.mjs');
    log.info(`starting the host through ${marker.hostService.kind} ${marker.hostService.name}`);
    await startService(marker.hostService);
  } else if (foreground) {
    return runForeground(cfg, log, cmd, args, token);
  } else {
    const fd = fs.openSync(cfg.hostLogFile, 'a', 0o600);
    const pid = spawnDetached(cmd, args, { env: cleanEnv(cfg), cwd: cfg.repoFolder, logFd: fd });
    fs.closeSync(fd);
    log.info(`started \`${path.basename(cmd)} agent host\` (pid ${pid}) on localhost:${port}`);
  }
  const ok = await waitFor(() => isListening(port), cfg.host.startTimeoutSeconds * 1000, 3000);
  maskTokenInFile(cfg.hostLogFile, token);
  if (ok) log.info(`host listening on ${port}`);
  else log.error(`host not listening on ${port} after ${cfg.host.startTimeoutSeconds} s; see ${cfg.hostLogFile}`);
  return !!ok;
}

/** Service mode: host output piped through redaction into host.log; returns when the port closes. */
async function runForeground(cfg, log, cmd, args, token) {
  const [file, fileArgs, opts] = winWrap(cmd, args);
  const out = fs.createWriteStream(cfg.hostLogFile, { flags: 'a', mode: 0o600 });
  const child = spawn(file, fileArgs, { env: cleanEnv(cfg), cwd: cfg.repoFolder, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts });
  const pipe = (s) => s.on('data', (d) => out.write(redact(String(d).split(token).join('<redacted>'))));
  pipe(child.stdout); pipe(child.stderr);
  let exited = false;
  child.on('exit', () => { exited = true; });
  const stop = () => { killTree(child.pid).finally(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  log.info(`host running in the foreground (pid ${child.pid}) on localhost:${cfg.host.port}`);
  const up = await waitFor(() => isListening(cfg.host.port), cfg.host.startTimeoutSeconds * 1000, 3000);
  if (!up) {
    log.error(`host not listening after ${cfg.host.startTimeoutSeconds} s; see ${cfg.hostLogFile}`);
    await killTree(child.pid);
    return false;
  }
  log.info(`host listening on ${cfg.host.port}`);
  // `code agent host` may hand off to a long-lived child and exit; supervise the port, not the child.
  let misses = 0;
  while (misses < 3) {
    await sleep(5000);
    misses = (await isListening(cfg.host.port)) ? 0 : misses + 1;
  }
  log.info(`host stopped listening on ${cfg.host.port}; exiting`);
  if (!exited) await killTree(child.pid);
  out.end();
  return true;
}

/** Stop the standalone host: kill its process tree, then wait for `runtimePid` (if given) to exit. */
/** @param {any} cfg @param {number} hostPid @param {any} log @param {{ runtimePid?: number, dryRun?: boolean }} [opts] */
export async function stopHost(cfg, hostPid, log, { runtimePid = undefined, dryRun = false } = {}) {
  if (dryRun) {
    log.info(`would stop host ${hostPid} (process tree)`);
    return true;
  }
  log.info(`stopping host ${hostPid}`);
  await killTree(hostPid);
  if (runtimePid) {
    const gone = await waitFor(() => !pidAlive(runtimePid), cfg.watch.runtimeExitTimeoutSeconds * 1000, 2000);
    if (!gone) {
      log.warn(`runtime ${runtimePid} still running ${cfg.watch.runtimeExitTimeoutSeconds} s after the host stopped; killing it`);
      await killTree(runtimePid);
    }
  }
  return !pidAlive(hostPid);
}

