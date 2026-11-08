// Scheduling per OS: a host service started at logon and a watcher run every N minutes.
//   Windows: two Task Scheduler tasks (interactive, least privilege).
//   macOS:   two launchd agents in ~/Library/LaunchAgents.
//   Linux:   a systemd user service for the host and a user timer for the watcher.
// The generators are pure (unit-tested on every OS); install/uninstall apply them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isListening, run } from './proc.mjs';
import { exists, inNpxCache, readJson, Refusal, samePath, sys32, writeJsonAtomic } from './util.mjs';

export const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'copilot-forever.mjs');

export const NPX_REFUSAL = 'copilot-forever is running from the npx cache, which npm can clear, so a schedule pointing at it would break. '
  + 'Install it for good with `npm install -g copilot-forever`, then run the same command with `copilot-forever` instead of `npx copilot-forever`.';

/** Minutes a watcher run may take, with margin: idle recheck, host stop/start and continue retries. */
export function watchTimeLimitMinutes(cfg) {
  const w = cfg.watch;
  const s = w.idleRecheckSeconds + w.runtimeExitTimeoutSeconds + cfg.host.startTimeoutSeconds + 120 + w.continueDelaySeconds +
    w.continueTries * (w.continueTimeoutSeconds + 35) + (w.continueTries - 1) * w.continueRetrySeconds;
  return Math.max(15, Math.ceil(s / 60) + 5);
}

export function names(cfg) {
  const n = cfg.instanceName;
  return {
    winHost: `${n} host`,
    winWatch: `${n} watch`,
    unitHost: `${n}-host.service`,
    unitWatch: `${n}-watch.service`,
    unitTimer: `${n}-watch.timer`,
    labelHost: `local.${n}.host`,
    labelWatch: `local.${n}.watch`,
  };
}

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Task Scheduler XML. The action runs node through Windows PowerShell inside a headless console
 * (`conhost.exe --headless`), so no window appears: `-WindowStyle Hidden` alone lets the console
 * flash for a moment before PowerShell hides it.
 */
/**
 * Bumped when the installed tasks/units change in a way an old install must pick up (run
 * `install` again). 2: the Windows host task runs `host start --direct`.
 */
export const SCHEDULE_VERSION = 2;

export function windowsTaskXml({ kind, cfg, node, userId, startBoundary }) {
  // --direct: the task itself is the service, so it must spawn the host, not ask the service to.
  const sub = kind === 'host' ? ['host', 'start', '--direct'] : ['watch'];
  const cmd = `& ${[node, BIN, ...sub, '--config', cfg.configFile].map(psq).join(' ')}; exit $LASTEXITCODE`;
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const args = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "${cmd.replace(/"/g, '\\"')}"`;
  const trigger = kind === 'host'
    ? `<LogonTrigger><Enabled>true</Enabled><UserId>${xml(userId)}</UserId><Delay>PT30S</Delay></LogonTrigger>`
    : `<TimeTrigger><Enabled>true</Enabled><StartBoundary>${xml(startBoundary)}</StartBoundary><Repetition><Interval>PT${cfg.watch.intervalMinutes}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger>`;
  const limit = kind === 'host' ? `PT${Math.ceil(cfg.host.startTimeoutSeconds / 60) + 5}M` : `PT${watchTimeLimitMinutes(cfg)}M`;
  const desc = kind === 'host'
    ? `copilot-forever: starts the standalone VS Code agent host on localhost:${cfg.host.port} at logon (does nothing if it is already listening).`
    : `copilot-forever: every ${cfg.watch.intervalMinutes} min, writes the session log status and runs a requested trim.`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xml(desc)}</Description></RegistrationInfo>
  <Triggers>${trigger}</Triggers>
  <Principals><Principal id="Author"><UserId>${xml(userId)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>${limit}</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(`${sysRoot}\\System32\\conhost.exe`)}</Command><Arguments>${xml(`--headless "${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" ${args}`)}</Arguments></Exec></Actions>
</Task>
`;
}

const sdq = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** systemd user units: { [fileName]: content } */
export function systemdUnits({ cfg, node, pathEnv }) {
  const n = names(cfg);
  const exec = (...a) => [node, BIN, ...a, '--config', cfg.configFile].map(sdq).join(' ');
  const env = `Environment=${sdq(`PATH=${pathEnv}`)}`;
  return {
    [n.unitHost]: `[Unit]
Description=copilot-forever: standalone VS Code agent host on localhost:${cfg.host.port}
After=default.target

[Service]
Type=simple
ExecStart=${exec('host', 'start', '--foreground')}
${env}
Restart=no
KillMode=control-group

[Install]
WantedBy=default.target
`,
    [n.unitWatch]: `[Unit]
Description=copilot-forever: session log status and requested trims

[Service]
Type=oneshot
ExecStart=${exec('watch')}
${env}
TimeoutStartSec=${watchTimeLimitMinutes(cfg)}min
`,
    [n.unitTimer]: `[Unit]
Description=copilot-forever: run the watcher every ${cfg.watch.intervalMinutes} min

[Timer]
OnBootSec=2min
OnUnitActiveSec=${cfg.watch.intervalMinutes}min
Unit=${n.unitWatch}

[Install]
WantedBy=timers.target
`,
  };
}

const plistEsc = xml;

/** launchd agent plists: { [fileName]: content } */
export function launchdPlists({ cfg, node, pathEnv }) {
  const n = names(cfg);
  const logs = path.join(cfg.stateDir, 'logs');
  const plist = (label, args, extra) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${plistEsc(label)}</string>
  <key>ProgramArguments</key>
  <array>
${[node, BIN, ...args, '--config', cfg.configFile].map((a) => `    <string>${plistEsc(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${plistEsc(pathEnv)}</string></dict>
  <key>StandardOutPath</key><string>${plistEsc(path.join(logs, `${label}.out.log`))}</string>
  <key>StandardErrorPath</key><string>${plistEsc(path.join(logs, `${label}.err.log`))}</string>
${extra}
</dict>
</plist>
`;
  return {
    [`${n.labelHost}.plist`]: plist(n.labelHost, ['host', 'start', '--foreground'],
      '  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><false/>\n  <key>ProcessType</key><string>Interactive</string>'),
    [`${n.labelWatch}.plist`]: plist(n.labelWatch, ['watch'],
      `  <key>RunAtLoad</key><true/>\n  <key>StartInterval</key><integer>${cfg.watch.intervalMinutes * 60}</integer>`),
  };
}

const uid = () => (typeof process.getuid === 'function' ? process.getuid() : 0);
const systemdDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
const launchDir = () => path.join(os.homedir(), 'Library', 'LaunchAgents');

async function must(log, dryRun, cmd, args, { okCodes = [0] } = {}) {
  log.info(`${dryRun ? 'would run' : 'run'}: ${cmd} ${args.join(' ')}`);
  if (dryRun) return { code: 0, stdout: '', stderr: '' };
  const r = await run(cmd, args, { timeoutMs: 60000 });
  if (!okCodes.includes(r.code)) throw new Error(`${cmd} ${args[0]} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
  return r;
}

function writeFile(log, dryRun, file, content, encoding = 'utf8') {
  if (dryRun) {
    log.info(`would write ${file}:\n${content}`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, encoding === 'utf16le' ? { encoding: 'utf16le' } : 'utf8');
  log.info(`wrote ${file}`);
}

/** Install the host service and the watcher schedule for this platform. */
export async function install(cfg, log, { dryRun = false, platform = process.platform, bin = BIN } = {}) {
  if (!cfg.configFile) throw new Refusal('install needs a config file on disk (pass --config)', 2);
  if (inNpxCache(bin)) throw new Refusal(NPX_REFUSAL, 2);
  // A project's own node_modules (npm install without -g) is cleared by a clean install or a prune.
  const kit = path.dirname(path.dirname(bin));
  if (kit.split(/[\\/]/).includes('node_modules')) {
    const root = await run('npm', ['root', '-g'], { timeoutMs: 30000 });
    if (!(root.code === 0 && samePath(path.dirname(kit), root.stdout.trim()))) {
      log.warn(`the schedule will run the kit from ${kit}, a project's node_modules, which a clean install or prune removes; npm install -g copilot-forever keeps it in place`);
    }
  }
  const node = process.execPath;
  const n = names(cfg);
  const pathEnv = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  let marker;
  if (platform === 'win32') {
    const who = (await run(sys32('whoami.exe'), [])).stdout.trim() || `${os.userInfo().username}`;
    const start = new Date(Date.now() + 60000);
    const pad = (x) => String(x).padStart(2, '0');
    const sb = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}:${pad(start.getMinutes())}:00`;
    const tmp = path.join(cfg.stateDir, 'install');
    for (const [kind, name] of [['host', n.winHost], ['watch', n.winWatch]]) {
      const file = path.join(tmp, `${kind}.xml`);
      // A BOM makes schtasks read the file as UTF-16, matching the declaration.
      writeFile(log, dryRun, file, '\uFEFF' + windowsTaskXml({ kind, cfg, node, userId: who, startBoundary: sb }), 'utf16le');
      await must(log, dryRun, sys32('schtasks.exe'), ['/Create', '/TN', name, '/XML', file, '/F']);
    }
    marker = { platform, hostService: { kind: 'schtasks', name: n.winHost }, watch: { kind: 'schtasks', name: n.winWatch } };
  } else if (platform === 'linux') {
    const dir = systemdDir();
    for (const [f, c] of Object.entries(systemdUnits({ cfg, node, pathEnv }))) writeFile(log, dryRun, path.join(dir, f), c);
    await must(log, dryRun, 'systemctl', ['--user', 'daemon-reload']);
    await must(log, dryRun, 'systemctl', ['--user', 'enable', n.unitHost]);
    await must(log, dryRun, 'systemctl', ['--user', 'enable', '--now', n.unitTimer]);
    marker = { platform, hostService: { kind: 'systemd', name: n.unitHost }, watch: { kind: 'systemd', name: n.unitTimer } };
  } else if (platform === 'darwin') {
    const dir = launchDir();
    for (const [f, c] of Object.entries(launchdPlists({ cfg, node, pathEnv }))) {
      writeFile(log, dryRun, path.join(dir, f), c);
      const label = f.replace(/\.plist$/, '');
      await must(log, dryRun, 'launchctl', ['bootout', `gui/${uid()}/${label}`], { okCodes: [0, 3, 5, 36, 113] });
      await must(log, dryRun, 'launchctl', ['bootstrap', `gui/${uid()}`, path.join(dir, f)]);
    }
    marker = { platform, hostService: { kind: 'launchd', name: n.labelHost }, watch: { kind: 'launchd', name: n.labelWatch } };
  } else {
    throw new Refusal(`unsupported platform ${platform}`, 2);
  }
  if (dryRun) log.info(`would record ${cfg.installMarker}`);
  else writeJsonAtomic(cfg.installMarker, { ...marker, schedule: SCHEDULE_VERSION, installedAt: new Date().toISOString(), configFile: cfg.configFile });
  log.info(platform === 'win32'
    ? 'installed. The host starts 30 s after each logon; start it now with: copilot-forever host start'
    : 'installed. The host service starts at login; the watcher timer is running.');
}

/** Stop the host for `uninstall --stop-host` (Windows); throws a Refusal saying what is left installed. */
async function stopHostForUninstall(cfg, log, { dryRun, stopper, listening, hostTask }) {
  const refuse = (why, fix = 'Stop the host with: copilot-forever host stop') => new Refusal(`${why}. The watcher task was removed; the host task "${hostTask}" is still installed. ${fix}, then run uninstall --stop-host again (or install to restore the watcher)`, 1);
  const stop = stopper ?? (await import('./host.mjs')).stopStandaloneHost;
  let r;
  try {
    r = await stop(cfg, log, { dryRun });
  } catch (e) {
    throw refuse(`could not stop the host: ${e?.message ?? e}`);
  }
  if (r === false) throw refuse(`the host on port ${cfg.host.port} did not stop`);
  // The port is the test: agent ps may not list a host that is still listening.
  if ((r === null || !dryRun) && (await listening(cfg.host.port))) {
    if (r === null) {
      throw refuse(`port ${cfg.host.port} is still listening, but no standalone host is listed there`,
        `Find the process on that port (Windows: netstat -ano | findstr :${cfg.host.port}) and stop it`);
    }
    throw refuse(`port ${cfg.host.port} is still listening after the stop`);
  }
  return refuse;
}

/**
 * Remove the schedule. The running host keeps running (stopping it would stop the agent);
 * pass stopHost to stop it as well.
 * @param {any} cfg @param {any} log
 * @param {{ dryRun?: boolean, stopHost?: boolean, platform?: string,
 *   stopper?: (cfg: any, log: any, o: { dryRun: boolean }) => Promise<boolean | null>,
 *   listening?: (port: number) => Promise<boolean>, lock?: (file: string) => (() => void) | null,
 *   deleteTask?: (name: string) => Promise<any> }} [opts]
 *   stopper, listening, lock and deleteTask are for tests; they default to the real host stop, port
 *   probe, watcher lock and schtasks /Delete.
 */
export async function uninstall(cfg, log, { dryRun = false, stopHost = false, platform = process.platform, stopper = undefined, listening = isListening, lock = undefined, deleteTask = undefined } = {}) {
  const n = names(cfg);
  if (platform === 'win32') {
    const del = deleteTask ?? ((name) => must(log, dryRun, sys32('schtasks.exe'), ['/Delete', '/TN', name, '/F'], { okCodes: [0, 1] }));
    // A watcher run in progress (a trim stops and restarts the host) holds the watcher lock.
    // Taking it before changing anything keeps such a run from restarting the host behind us.
    const release = stopHost && !dryRun ? (lock ?? (await import('./watch.mjs')).takeLock)(cfg.lockFile) : () => {};
    if (!release) throw new Refusal(`a watcher run is in progress (it may be trimming and restarting the host); no task was changed. Wait for it to finish and run uninstall again. If no watcher is running, the lock is stale: delete ${cfg.lockFile}`, 1);
    try {
      // Removing the watcher task first stops future watcher runs from starting the host again.
      await del(n.winWatch);
      // Deleting a scheduled task does not stop the process it started, so stop the host directly.
      // Any failure stops here, while the host task and the install marker still match.
      if (stopHost) {
        const refuse = await stopHostForUninstall(cfg, log, { dryRun, stopper, listening, hostTask: n.winHost });
        try {
          await del(n.winHost);
        } catch (e) {
          throw refuse(`the host stopped, but deleting its task failed: ${e?.message ?? e}`, 'Delete the task in Task Scheduler');
        }
      } else {
        await del(n.winHost);
      }
    } finally {
      release();
    }
  } else if (platform === 'linux') {
    await must(log, dryRun, 'systemctl', ['--user', 'disable', '--now', n.unitTimer], { okCodes: [0, 1, 5] });
    await must(log, dryRun, 'systemctl', ['--user', 'disable', ...(stopHost ? ['--now'] : []), n.unitHost], { okCodes: [0, 1, 5] });
    for (const f of Object.keys(systemdUnits({ cfg, node: '', pathEnv: '' }))) {
      const p = path.join(systemdDir(), f);
      if (dryRun) log.info(`would remove ${p}`);
      else if (exists(p)) fs.unlinkSync(p);
    }
    await must(log, dryRun, 'systemctl', ['--user', 'daemon-reload']);
  } else if (platform === 'darwin') {
    await must(log, dryRun, 'launchctl', ['bootout', `gui/${uid()}/${n.labelWatch}`], { okCodes: [0, 3, 5, 36, 113] });
    // Unloading the host job stops the host; without --stop-host only its plist goes, so it is
    // not started again at the next login.
    if (stopHost) await must(log, dryRun, 'launchctl', ['bootout', `gui/${uid()}/${n.labelHost}`], { okCodes: [0, 3, 5, 36, 113] });
    for (const f of Object.keys(launchdPlists({ cfg, node: '', pathEnv: '' }))) {
      const p = path.join(launchDir(), f);
      if (dryRun) log.info(`would remove ${p}`);
      else if (exists(p)) fs.unlinkSync(p);
    }
  } else {
    throw new Refusal(`unsupported platform ${platform}`, 2);
  }
  if (dryRun) log.info(`would remove ${cfg.installMarker}`);
  else if (exists(cfg.installMarker)) fs.unlinkSync(cfg.installMarker);
  log.info(stopHost ? 'uninstalled.' : 'uninstalled. A host that is running keeps running; stop it with: copilot-forever host stop');
}

/** Start the installed host service. */
export async function startService(svc) {
  let r;
  if (svc.kind === 'schtasks') r = await run(sys32('schtasks.exe'), ['/Run', '/TN', svc.name]);
  else if (svc.kind === 'systemd') r = await run('systemctl', ['--user', 'start', svc.name]);
  else if (svc.kind === 'launchd') r = await run('launchctl', ['kickstart', `gui/${uid()}/${svc.name}`]);
  else throw new Error(`unknown service kind ${svc.kind}`);
  if (r.code !== 0) throw new Error(`starting ${svc.name} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
}

export function installedMarker(cfg) {
  try { return readJson(cfg.installMarker); } catch { return null; }
}
