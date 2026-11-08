#!/usr/bin/env node
// copilot-forever: keep one long-lived GitHub Copilot agent session running for days.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(`copilot-forever needs Node 22 or newer (this is ${process.versions.node})`);
  process.exit(2);
}

const { CONFIG_NAME, continueMessage, loadConfig, resolveConfig, starterConfig } = await import('../src/config.mjs');
const { Logger } = await import('../src/log.mjs');
const { Refusal, exists, readJson, vscodeFileUri } = await import('../src/util.mjs');

const HELP = `copilot-forever <command> [options]

Commands
  setup [--repo <folder>]     Set up the goal loop in a repository (default: this folder) and print the next
                              steps; takes goal-loop's options
  protect [--repo <folder>]   Require pull requests for the repository's default branch on GitHub, admins included
  init --repo <folder>        Write ${CONFIG_NAME} (here, or at --config) and create the token file
  doctor                      Check config, tools, versions, host, session and log layout (read-only)
  host start [--foreground]   Start the standalone agent host on localhost:<port> (no-op if listening)
       [--direct]             ... spawn it here even when the host service is installed
                              (--foreground always spawns it, so --direct adds nothing there)
  host stop                   Stop the standalone host (stops the agent session's runtime too)
  host status                 Show the host and the session it runs
  watch                       One watcher run: status file, and a trim if the agent requested one
  trim <session-id>           Trim a stopped session's log to its latest successful compaction
       [--copy <new-id>]      ... into a new session folder, leaving the source untouched
  continue [--session <uri>]  Send the continue message over the Agent Host Protocol
       [--text <msg>] [--probe]
  install / uninstall         Schedule the host and watcher (Task Scheduler / launchd / systemd)
       [--stop-host]          uninstall: also stop the running host
  snippet                     Print the agent-side instructions with your configured paths
  report [--session <id|path>] [--out <file>] [--json]
                              Timing report: where the session's time went, per role and per run
  goal-loop --repo <folder>   Render the goal-loop agents, gate and handoff into a repository
       [--goal-config <file>] [--no-install] [--no-effort] [--start] (same as bootstrap.mjs)
  loop --mode ralph [--repo <folder>] [--max-iterations <n>]
                              Run the goal loop as fresh copilot -p Orchestrator runs (Ralph mode)
  loop approve-plan [--repo <folder>]
                              Record your approval of .goal-loop/PLAN.md (Ralph mode)

Options
  --config <file>   Config file (default: $COPILOT_FOREVER_CONFIG, ./${CONFIG_NAME}, ~/.copilot-forever/config.json)
  --dry-run         Do every check, change nothing (all commands)
  --force           trim/watch: proceed although the Copilot version is untested (log layout is always checked)
  -h, --help
`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    foreground: { type: 'boolean', default: false },
    direct: { type: 'boolean', default: false },
    repo: { type: 'string' },
    copy: { type: 'string' },
    session: { type: 'string' },
    text: { type: 'string' },
    probe: { type: 'boolean', default: false },
    'stop-host': { type: 'boolean', default: false },
    timeout: { type: 'string' },
    'goal-config': { type: 'string' },
    'no-install': { type: 'boolean', default: false },
    'no-effort': { type: 'boolean', default: false },
    'no-link': { type: 'boolean', default: false },
    'allow-same-family': { type: 'boolean', default: false },
    start: { type: 'boolean', default: false },
    mode: { type: 'string' },
    'max-iterations': { type: 'string' },
    out: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const dryRun = o['dry-run'];
const [cmd, sub, ...rest] = positionals;
const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  if (o.help || !cmd) {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === 'init') return init();
  if (cmd === 'goal-loop' || cmd === 'setup') {
    if (!o.repo && cmd === 'goal-loop') throw new Refusal('usage: copilot-forever goal-loop --repo <folder> [--goal-config <file>] [--dry-run] [--force] [--no-install] [--no-effort]', 2);
    const { bootstrap } = await import('../src/goal-loop.mjs');
    await bootstrap({ repo: o.repo ?? '.', config: o['goal-config'], dryRun, force: o.force, install: !o['no-install'], link: !o['no-link'],
      allowSameFamily: o['allow-same-family'], effort: !o['no-effort'], start: o.start, log: new Logger({ dryRun, prefix: `${cmd}: ` }) });
    return 0;
  }
  if (cmd === 'protect') {
    const { protectDefaultBranch } = await import('../src/goal-loop.mjs');
    const r = await protectDefaultBranch(path.resolve(o.repo ?? '.'), new Logger({ dryRun, prefix: 'protect: ' }), { dryRun });
    return r === 'failed' ? 1 : 0;
  }
  if (cmd === 'loop') {
    const ralph = await import('../src/ralph.mjs');
    const repo = path.resolve(o.repo ?? '.');
    const log = new Logger({ dryRun, prefix: 'loop: ', file: dryRun ? undefined : path.join(repo, '.goal-loop', 'ralph', 'runner.log') });
    if (sub === 'approve-plan') {
      ralph.approvePlan(repo, log);
      return 0;
    }
    if (o.mode === 'persistent') {
      log.info('persistent mode runs in VS Code: start a session on the standalone host with the Orchestrator agent and send "start" (see templates/goal-loop/README.md)');
      return 0;
    }
    if (o.mode !== 'ralph') throw new Refusal('usage: copilot-forever loop --mode ralph [--repo <folder>] [--max-iterations <n>] [--dry-run] | loop approve-plan [--repo <folder>]', 2);
    const max = o['max-iterations'] === undefined ? undefined : Number(o['max-iterations']);
    if (max !== undefined && !(Number.isInteger(max) && max > 0)) throw new Refusal('--max-iterations must be a positive integer', 2);
    const r = await ralph.ralphLoop({ repo, log, dryRun, maxIterations: max });
    return r.exitCode;
  }

  if (cmd === 'report') {
    const { report } = await import('../src/report.mjs');
    // With --session and no --config, a missing config is fine: a path needs none, and
    // sessionFiles says what is wrong with anything else.
    let cfgOrNull = null;
    if (!o.session || o.config) {
      try { cfgOrNull = loadConfig(o.config); } catch (e) {
        if (e instanceof Refusal && /no config file found/.test(e.message)) throw new Refusal(`${e.message} Or name the session: report --session <folder or events.jsonl path>.`, 2);
        throw e;
      }
    }
    else try { cfgOrNull = loadConfig(undefined); } catch (e) { if (!(e instanceof Refusal && /no config file found/.test(e.message))) throw e; }
    const r = await report(cfgOrNull, { session: o.session, json: o.json, out: o.out });
    if (o.out) process.stderr.write(`report written to ${o.out}\n`);
    else process.stdout.write(r.text);
    if (r.unreadable) process.stderr.write(`note: ${r.unreadable} unreadable log line(s) skipped\n`);
    return 0;
  }

  const cfg = loadConfig(o.config);
  const log = new Logger({ file: dryRun ? undefined : cfg.logFile, dryRun, prefix: cmd === 'watch' ? '' : `${cmd}: ` });

  switch (cmd) {
    case 'doctor': {
      const { doctor } = await import('../src/doctor.mjs');
      return (await doctor(cfg, log)) ? 0 : 1;
    }
    case 'host': {
      const h = await import('../src/host.mjs');
      if (sub === 'start') return (await h.startHost(cfg, log, { dryRun, foreground: o.foreground, viaService: o.direct ? false : undefined })) ? 0 : 1;
      if (sub === 'stop' || sub === 'status') {
        const r = await h.stopStandaloneHost(cfg, log, { dryRun, statusOnly: sub === 'status' });
        if (r === null) return sub === 'status' ? 1 : 0;
        return r ? 0 : 1;
      }
      throw new Refusal('usage: copilot-forever host start|stop|status', 2);
    }
    case 'watch': {
      const { watchOnce } = await import('../src/watch.mjs');
      const r = await watchOnce(cfg, log, { dryRun, force: o.force });
      return r.state === 'trimmed' && !(r.trim && r.up) ? 1 : 0;
    }
    case 'trim': {
      const id = sub;
      if (!id) throw new Refusal('usage: copilot-forever trim <session-id> [--copy <new-id>] [--dry-run] [--force]', 2);
      const { trimSession } = await import('../src/trim.mjs');
      const { checkVersions, readFirstEvent } = await import('../src/session.mjs');
      const v = await checkVersions(cfg, { sessionStartEvent: readFirstEvent(path.join(cfg.sessionStateDir, id, 'events.jsonl')) });
      v.notes.forEach((n) => log.info(n));
      if (v.problems.length && !o.force) throw new Refusal(`untested Copilot version: ${v.problems.join('; ')} (--force to proceed)`, 6);
      trimSession({ sessionStateDir: cfg.sessionStateDir, archiveDir: cfg.trim.archiveDir, sessionId: id, copyTo: o.copy, dryRun, knownVersions: cfg.copilot.knownLogVersions, log });
      return 0;
    }
    case 'continue': {
      const { continueSession } = await import('../src/ahp.mjs');
      const { readToken } = await import('../src/host.mjs');
      let sessionUri = o.session;
      if (!sessionUri) {
        try { sessionUri = readJson(cfg.files.status).ahp_session; } catch { /* none */ }
      }
      if (!sessionUri) throw new Refusal(`no --session given and no ahp_session in ${cfg.files.status}`, 2);
      const r = await continueSession({
        port: cfg.host.port, token: readToken(cfg), sessionUri, log, probe: o.probe, dryRun,
        text: o.text ?? continueMessage(cfg),
        timeoutMs: 1000 * Number(o.timeout ?? cfg.watch.continueTimeoutSeconds),
        expectAgent: path.basename(cfg.agentFile), agentUri: vscodeFileUri(cfg.agentFile),
      });
      (r.ok ? log.info : log.error).call(log, r.detail);
      return r.ok ? 0 : 1;
    }
    case 'install': {
      const { install } = await import('../src/install.mjs');
      await install(cfg, log, { dryRun });
      return 0;
    }
    case 'uninstall': {
      const { uninstall } = await import('../src/install.mjs');
      await uninstall(cfg, log, { dryRun, stopHost: o['stop-host'] });
      return 0;
    }
    case 'snippet': {
      process.stdout.write(renderSnippet(cfg));
      return 0;
    }
    default:
      throw new Refusal(`unknown command ${cmd}; see --help`, 2);
  }
}

function renderSnippet(cfg) {
  const rel = (p) => path.relative(cfg.repoFolder, p).replace(/\\/g, '/');
  return fs.readFileSync(path.join(here, '..', 'agent', 'snippet.md'), 'utf8')
    .replaceAll('{{status}}', rel(cfg.files.status))
    .replaceAll('{{request}}', rel(cfg.files.request))
    .replaceAll('{{handoff}}', rel(cfg.files.handoff));
}

async function init() {
  if (!o.repo) throw new Refusal('usage: copilot-forever init --repo <folder> [--config <file>]', 2);
  const repo = path.resolve(o.repo);
  if (!exists(repo)) throw new Refusal(`${repo} does not exist`, 2);
  const file = path.resolve(o.config ?? CONFIG_NAME);
  if (exists(file) && !o.force) throw new Refusal(`${file} exists (--force to overwrite)`, 2);
  const text = JSON.stringify(starterConfig(repo), null, 2) + '\n';
  const log = new Logger({ dryRun, prefix: 'init: ' });
  if (dryRun) {
    log.info(`would write ${file}:\n${text}`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    log.info(`wrote ${file}`);
  }
  const cfg = loadConfigFrom(file, text);
  const { ensureToken } = await import('../src/host.mjs');
  await ensureToken(cfg, log, { dryRun });
  log.info('next: edit the config if needed, paste `copilot-forever snippet` into your agent file, run `copilot-forever doctor`, then `copilot-forever install`.');
  return 0;
}

function loadConfigFrom(file, text) {
  // In a dry run the file was not written: resolve the starter text instead.
  return exists(file) ? loadConfig(file) : resolveConfig(JSON.parse(text), path.dirname(file), file);
}

main().then(
  (code) => { process.exitCode = code ?? 0; },
  (e) => {
    if (e instanceof Refusal) {
      console.error(`copilot-forever: ${e.message}`);
      process.exitCode = e.exitCode;
    } else {
      console.error(`copilot-forever: error: ${e?.stack ?? e}`);
      process.exitCode = 1;
    }
  },
);
