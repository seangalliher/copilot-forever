// Loads copilot-forever.config.json, fills defaults, resolves paths and validates.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome, readJson, resolvePath, Refusal } from './util.mjs';

export const CONFIG_NAME = 'copilot-forever.config.json';

export const DEFAULTS = Object.freeze({
  // Folder the long-lived session works in (its `cwd`). Required.
  repoFolder: null,
  // The custom agent file, relative to repoFolder. Used to check and to pick the agent on continue.
  agentFile: '.github/agents/orchestrator.agent.md',
  // Name used for scheduled tasks / units / launch agents. Change it to run more than one instance.
  instanceName: 'copilot-forever',
  // Where Copilot keeps session-state/. Respects COPILOT_HOME when set.
  copilotHome: process.env.COPILOT_HOME || '~/.copilot',
  // This kit's own folder: token, logs, lock.
  stateDir: '~/.copilot-forever',
  host: {
    // The VS Code CLI: a command name on PATH, or an array [executable, ...leadingArgs].
    codeCommand: 'code',
    port: 47801,
    // Connection token file. Created with owner-only permissions if missing.
    tokenFile: null, // default: <stateDir>/token.txt
    startTimeoutSeconds: 180,
    // Extra environment variable names to pass to the host besides the built-in allowlist.
    passEnv: [],
    // 'auto': start through the installed OS service if `install` ran, else spawn directly.
    // 'direct': always spawn directly.
    startVia: 'auto',
  },
  trim: {
    thresholdMiB: 400,
    archiveDir: null, // default: <copilotHome>/session-archive
  },
  watch: {
    intervalMinutes: 10,
    quietSeconds: 120,
    idleRecheckSeconds: 90,
    runtimeExitTimeoutSeconds: 60,
    continueDelaySeconds: 20,
    continueTries: 3,
    continueRetrySeconds: 30,
    continueTimeoutSeconds: 180,
    // Notify when the host still lists the session as running although its last turn ended and
    // the log has been quiet this long (a stale host status blocks trims and resumes). 0 = off.
    staleHostMinutes: 30,
  },
  // Files the agent reads and writes, relative to repoFolder.
  files: {
    status: 'logs/session-log-status.json',
    request: 'logs/trim-request.json',
    history: 'logs/trim-history',
    handoff: 'logs/agent-handoff.md',
  },
  continueText:
    'Continue. Your session log was just trimmed to its latest compaction after you stopped for a log trim. ' +
    'Resume from the latest addendum in {handoff}.',
  // Network resume: continue the agent when its last turn died on a network error and the model
  // API answers again. See src/resume.mjs.
  resume: {
    enabled: true,
    quietMinutes: 15,
    retryMinutes: 20,
    maxTries: 3,
    maxPerDay: 8, // continues across all errors in 24 hours
    apiHost: null, // default: the host in the error message, else api.githubcopilot.com
    apiPort: 443,
    probeTimeoutSeconds: 5,
    text:
      'Continue. Your last turn failed on a network error at {time} and the connection is back. ' +
      'Check where you were (git state, running work, the latest addendum in {handoff}) before resuming.',
  },
  // Stall resume: continue the agent when its last turn launched background work and ended to
  // wait for it, but no completion notification ever woke it. See src/resume.mjs.
  stall: {
    enabled: true,
    quietMinutes: 20, // or the longest Start-Sleep in that turn plus 5 minutes, if longer
    maxTries: 2, // continues per stall
    maxPerDay: 24, // continues across all stalls in 24 hours
    text:
      'Continue. You ended your turn at {time} waiting on background work ({work}), and nothing woke you: ' +
      'the completion notification was not delivered. Check the output of that work now. For anything still running, ' +
      'wait in the foreground (a sync wait or a read with a timeout) instead of ending the turn.',
  },
  notify: true,
  // Refuse to trim when `copilot --version` reports a major version other than these.
  copilot: {
    supportedMajors: [1],
    // Known events.jsonl header schema versions (session.start data.version).
    knownLogVersions: [1],
  },
});

function merge(base, over) {
  if (over === undefined) return base;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

/** Where to look for the config file, in order. */
export function configCandidates(explicit) {
  if (explicit) return [path.resolve(expandHome(explicit))];
  const list = [];
  if (process.env.COPILOT_FOREVER_CONFIG) list.push(path.resolve(expandHome(process.env.COPILOT_FOREVER_CONFIG)));
  list.push(path.resolve(CONFIG_NAME));
  list.push(path.join(os.homedir(), '.copilot-forever', 'config.json'));
  return list;
}

export function findConfig(explicit) {
  const c = configCandidates(explicit);
  const hit = c.find((p) => fs.existsSync(p));
  if (!hit) {
    throw new Refusal(
      `no config file found (looked in: ${c.join(', ')}). Run \`copilot-forever init --repo <folder>\` or pass --config.`,
      2,
    );
  }
  return hit;
}

const isPosInt = (v) => Number.isInteger(v) && v >= 0;

/** Validate a merged config; returns a list of problems (empty = fine). */
export function validate(cfg) {
  const p = [];
  if (!cfg.repoFolder || typeof cfg.repoFolder !== 'string') p.push('repoFolder is required');
  if (!Number.isInteger(cfg.host.port) || cfg.host.port < 1024 || cfg.host.port > 65535) p.push('host.port must be an integer 1024-65535');
  const cc = cfg.host.codeCommand;
  if (!(typeof cc === 'string' && cc) && !(Array.isArray(cc) && cc.length && cc.every((x) => typeof x === 'string'))) {
    p.push('host.codeCommand must be a command name or a non-empty array of strings');
  }
  if (!['auto', 'direct'].includes(cfg.host.startVia)) p.push("host.startVia must be 'auto' or 'direct'");
  if (!Array.isArray(cfg.host.passEnv)) p.push('host.passEnv must be an array of names');
  if (typeof cfg.trim.thresholdMiB !== 'number' || cfg.trim.thresholdMiB <= 0) p.push('trim.thresholdMiB must be a positive number');
  for (const [k, v] of Object.entries(cfg.watch)) if (!isPosInt(v)) p.push(`watch.${k} must be a non-negative integer`);
  if (cfg.watch.intervalMinutes < 1) p.push('watch.intervalMinutes must be at least 1');
  if (cfg.watch.continueTries < 1) p.push('watch.continueTries must be at least 1');
  for (const k of ['status', 'request', 'history', 'handoff']) if (typeof cfg.files[k] !== 'string' || !cfg.files[k]) p.push(`files.${k} must be a path`);
  if (typeof cfg.continueText !== 'string' || !cfg.continueText.trim()) p.push('continueText must be non-empty');
  const r = cfg.resume;
  if (typeof r.enabled !== 'boolean') p.push('resume.enabled must be true or false');
  for (const k of ['quietMinutes', 'retryMinutes', 'maxTries', 'maxPerDay', 'probeTimeoutSeconds']) if (!isPosInt(r[k])) p.push(`resume.${k} must be a non-negative integer`);
  if (r.maxTries < 1) p.push('resume.maxTries must be at least 1');
  if (r.maxPerDay < 1) p.push('resume.maxPerDay must be at least 1');
  if (r.probeTimeoutSeconds < 1) p.push('resume.probeTimeoutSeconds must be at least 1');
  if (!Number.isInteger(r.apiPort) || r.apiPort < 1 || r.apiPort > 65535) p.push('resume.apiPort must be an integer 1-65535');
  if (r.apiHost !== null && (typeof r.apiHost !== 'string' || !r.apiHost)) p.push('resume.apiHost must be a host name or null');
  if (typeof r.text !== 'string' || !r.text.trim()) p.push('resume.text must be non-empty');
  const s = cfg.stall;
  if (typeof s.enabled !== 'boolean') p.push('stall.enabled must be true or false');
  for (const k of ['quietMinutes', 'maxTries', 'maxPerDay']) if (!isPosInt(s[k]) || s[k] < 1) p.push(`stall.${k} must be a positive integer`);
  if (typeof s.text !== 'string' || !s.text.trim()) p.push('stall.text must be non-empty');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(cfg.instanceName)) p.push('instanceName may use letters, digits, . _ - (max 64)');
  return p;
}

/**
 * Load and resolve the config. All paths in the result are absolute.
 * @param {string|undefined} explicit path from --config
 */
export function loadConfig(explicit) {
  const file = findConfig(explicit);
  let raw;
  try {
    raw = readJson(file);
  } catch (e) {
    throw new Refusal(`cannot parse ${file}: ${e.message}`, 2);
  }
  return resolveConfig(raw, path.dirname(file), file);
}

export function resolveConfig(raw, baseDir, file = null) {
  const cfg = merge(structuredClone(DEFAULTS), raw);
  const problems = validate(cfg);
  if (problems.length) throw new Refusal(`invalid config${file ? ` ${file}` : ''}:\n  - ${problems.join('\n  - ')}`, 2);

  cfg.configFile = file;
  cfg.repoFolder = resolvePath(cfg.repoFolder, baseDir);
  cfg.copilotHome = resolvePath(cfg.copilotHome, baseDir);
  cfg.stateDir = resolvePath(cfg.stateDir, baseDir);
  cfg.agentFile = resolvePath(cfg.agentFile, cfg.repoFolder);
  cfg.host.tokenFile = resolvePath(cfg.host.tokenFile ?? path.join(cfg.stateDir, 'token.txt'), baseDir);
  cfg.trim.archiveDir = resolvePath(cfg.trim.archiveDir ?? path.join(cfg.copilotHome, 'session-archive'), baseDir);
  for (const k of Object.keys(cfg.files)) cfg.files[k] = resolvePath(cfg.files[k], cfg.repoFolder);
  if (typeof cfg.host.codeCommand === 'string') cfg.host.codeCommand = [cfg.host.codeCommand];
  cfg.host.codeCommand = cfg.host.codeCommand.map((x, i) => (i === 0 ? expandHome(x) : x));
  cfg.sessionStateDir = path.join(cfg.copilotHome, 'session-state');
  cfg.logFile = path.join(cfg.stateDir, 'logs', 'copilot-forever.log');
  cfg.hostLogFile = path.join(cfg.stateDir, 'logs', `host-${cfg.instanceName}.log`);
  cfg.lockFile = path.join(cfg.stateDir, `watch-${cfg.instanceName}.lock`);
  cfg.resumeStateFile = path.join(cfg.stateDir, `resume-${cfg.instanceName}.json`);
  cfg.stallStateFile = path.join(cfg.stateDir, `stall-${cfg.instanceName}.json`);
  cfg.staleStateFile = path.join(cfg.stateDir, `stale-${cfg.instanceName}.json`);
  cfg.installMarker = path.join(cfg.stateDir, `installed-${cfg.instanceName}.json`);
  return cfg;
}

/** The continue message with {handoff} replaced by the handoff file's path relative to the repo. */
export function continueMessage(cfg) {
  const rel = path.relative(cfg.repoFolder, cfg.files.handoff).replace(/\\/g, '/');
  return cfg.continueText.replaceAll('{handoff}', rel);
}

/** A starter config for `init`. */
export function starterConfig(repoFolder) {
  return {
    repoFolder,
    agentFile: DEFAULTS.agentFile,
    instanceName: DEFAULTS.instanceName,
    host: { codeCommand: 'code', port: DEFAULTS.host.port },
    trim: { thresholdMiB: DEFAULTS.trim.thresholdMiB },
    watch: { intervalMinutes: DEFAULTS.watch.intervalMinutes },
    files: { ...DEFAULTS.files },
    continueText: DEFAULTS.continueText,
  };
}
