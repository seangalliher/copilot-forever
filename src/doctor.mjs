// `doctor`: read-only checks of everything the watcher depends on.
import fs from 'node:fs';
import path from 'node:path';
import { agentPs, findStandaloneHost } from './host.mjs';
import { installedMarker, SCHEDULE_VERSION } from './install.mjs';
import { isListening, processTable, run } from './proc.mjs';
import { checkSchema, readEvents } from './schema.mjs';
import { checkVersions, findSession, readFirstEvent } from './session.mjs';
import { findCut } from './trim.mjs';
import { exists, isWindows, mib } from './util.mjs';

export async function doctor(cfg, log) {
  let ok = true;
  const pass = (m) => log.info(`ok    ${m}`);
  const warn = (m) => log.info(`warn  ${m}`);
  const fail = (m) => { ok = false; log.info(`FAIL  ${m}`); };

  pass(`config ${cfg.configFile}`);
  pass(`node ${process.versions.node}`);
  exists(cfg.repoFolder) ? pass(`repo folder ${cfg.repoFolder}`) : fail(`repo folder ${cfg.repoFolder} does not exist`);
  if (exists(cfg.agentFile)) {
    const text = fs.readFileSync(cfg.agentFile, 'utf8');
    const rel = path.relative(cfg.repoFolder, cfg.files.request).replace(/\\/g, '/');
    text.includes(rel) ? pass(`agent file ${cfg.agentFile} mentions ${rel}`) : warn(`agent file ${cfg.agentFile} does not mention ${rel}; paste \`copilot-forever snippet\` into it`);
  } else warn(`agent file ${cfg.agentFile} not found`);

  const [code, ...lead] = cfg.host.codeCommand;
  const v = await run(code, [...lead, '--version'], { timeoutMs: 30000 });
  v.code === 0 ? pass(`VS Code CLI (${path.basename(code)}) ${v.stdout.split(/\r?\n/)[0]}`) : fail(`\`${code} --version\` failed; set host.codeCommand`);

  if (exists(cfg.host.tokenFile)) {
    if (!isWindows && (fs.statSync(cfg.host.tokenFile).mode & 0o077)) fail(`token file ${cfg.host.tokenFile} is readable by others (chmod 600)`);
    else pass(`token file ${cfg.host.tokenFile}${isWindows ? '' : ' (mode 600)'}`);
  } else warn(`token file ${cfg.host.tokenFile} missing (created on first host start)`);

  const marker = installedMarker(cfg);
  if (!marker) warn('not installed (run `copilot-forever install`)');
  else if ((marker.schedule ?? 1) < SCHEDULE_VERSION) {
    warn(`installed by an older kit (schedule ${marker.schedule ?? 1}, current ${SCHEDULE_VERSION}): run \`copilot-forever install\` again${isWindows ? '; until then the host task cannot start the host at logon or after a trim' : ''}`);
  } else pass(`installed (${marker.hostService.kind}: ${marker.hostService.name}, ${marker.watch.name})`);

  (await isListening(cfg.host.port)) ? pass(`port ${cfg.host.port} listening`) : warn(`port ${cfg.host.port} not listening`);
  let hostInfo = null;
  try {
    hostInfo = findStandaloneHost(await agentPs(cfg), cfg.host.port);
  } catch (e) {
    fail(e.message);
  }
  if (!hostInfo) {
    warn(`no standalone host on port ${cfg.host.port}`);
    const vv = await checkVersions(cfg);
    vv.notes.forEach((n) => pass(n));
    vv.problems.forEach((p) => fail(p));
    return ok;
  }
  pass(`standalone host pid ${hostInfo.host.pid} at ${hostInfo.host.address}`);
  const session = findSession(cfg, Number(hostInfo.host.pid), await processTable());
  if (!session) {
    warn(`no session for ${cfg.repoFolder} runs under the host`);
    return ok;
  }
  pass(`session ${session.id}: ${mib(session.size)} MiB (threshold ${cfg.trim.thresholdMiB}), runtime pid ${session.runtimePid}`);
  const file = path.join(session.dir, 'events.jsonl');
  const vv = await checkVersions(cfg, { sessionStartEvent: readFirstEvent(file) });
  vv.notes.forEach((n) => pass(n));
  vv.problems.forEach((p) => fail(p));
  try {
    const { events } = readEvents(file);
    const p = checkSchema(events, { sessionId: session.id, knownVersions: cfg.copilot.knownLogVersions });
    p.length ? fail(`log layout: ${p.join('; ')}`) : pass(`log layout known (${events.length} events)`);
    const { cut, reason } = findCut(events);
    cut === null ? warn(reason) : pass(`a trim would keep events from ${cut + 1} of ${events.length}`);
  } catch (e) {
    fail(`cannot read the log: ${e.message}`);
  }
  return ok;
}
