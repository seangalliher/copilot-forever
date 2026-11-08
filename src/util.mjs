// Small shared helpers: paths, time, file writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const isWindows = process.platform === 'win32';

/** Absolute path of a Windows system tool, so a same-named tool earlier on PATH (Git's whoami) is not used. */
export const sys32 = (exe) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);

/** How to put VS Code's `code` command on PATH on this platform. */
export function codeOnPathHint(platform = process.platform) {
  if (platform === 'win32') return 'run the VS Code installer again with "Add to PATH" ticked, then open a new terminal';
  if (platform === 'darwin') return 'in VS Code, run the command "Shell Command: Install \'code\' command in PATH", then open a new terminal';
  return 'install VS Code from its .deb or .rpm package (it puts code on PATH), then open a new terminal';
}

/** True when a path is inside npx's cache, which npm may clear at any time. */
export const inNpxCache = (p) => p.split(/[\\/]/).includes('_npx');

/** Expand a leading `~` to the home directory. */
export function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Resolve `p` (with `~`) against `base` unless it is absolute. */
export function resolvePath(p, base) {
  const e = expandHome(p);
  return path.isAbsolute(e) ? path.normalize(e) : path.resolve(base, e);
}

/** Compare two filesystem paths the way the OS does (case-insensitive on Windows and macOS). */
export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    let n = path.resolve(p).replace(/[\\/]+$/, '');
    if (process.platform === 'win32' || process.platform === 'darwin') n = n.toLowerCase();
    return n;
  };
  return norm(a) === norm(b);
}

/** A file:// URI or a plain path, as a plain path. */
export function uriToPath(s) {
  if (typeof s !== 'string') return s;
  if (!s.startsWith('file:')) return s;
  try {
    const u = new URL(s);
    let p = decodeURIComponent(u.pathname);
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1); // /d:/x -> d:/x
    return path.normalize(p);
  } catch {
    return s;
  }
}

/**
 * A path as VS Code writes file URIs: lower-case drive letter and an encoded colon on Windows
 * (file:///d%3A/repo/x.agent.md), each segment percent-encoded.
 */
export function vscodeFileUri(p) {
  let abs = path.resolve(p).replace(/\\/g, '/');
  let prefix = '';
  const m = /^([a-zA-Z]):(\/.*)?$/.exec(abs);
  if (m) {
    prefix = '/' + m[1].toLowerCase() + '%3A';
    abs = m[2] ?? '/';
  }
  const enc = abs.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return 'file://' + prefix + enc;
}

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
export const stampUtc = () => nowIso().replace(/[-:]/g, '');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const mib = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

/** Write a file atomically: write a sibling temp file, then rename over the target. */
export function writeFileAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

export function writeJsonAtomic(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

export function exists(p) {
  try { fs.statSync(p); return true; } catch { return false; }
}

/** Poll `fn` until it returns truthy or `timeoutMs` passes. Returns the last value. */
export async function waitFor(fn, timeoutMs, stepMs = 1000) {
  const end = Date.now() + timeoutMs;
  let v = await fn();
  while (!v && Date.now() < end) {
    await sleep(stepMs);
    v = await fn();
  }
  return v;
}

/** Thrown for an expected refusal: the CLI prints the message and exits with `code`. */
export class Refusal extends Error {
  constructor(message, code = 3) {
    super(message);
    this.name = 'Refusal';
    this.exitCode = code;
  }
}
