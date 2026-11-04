#!/usr/bin/env node
// A fake VS Code CLI for end-to-end tests:  node fake-code.mjs --state <state.json> <code args...>
//   --version                 prints a version
//   agent ps --json           lists the fake standalone host while its PID is alive
//   agent host --port P --connection-token-file F ...
//                             runs a fake AHP server on P, starts a fake copilot-runtime child that
//                             holds the session lock, prints a banner containing the token, and
//                             records its environment and received turns in the state folder.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeAhp } from './fake-ahp-server.mjs';

const argv = process.argv.slice(2);
const si = argv.indexOf('--state');
const stateFile = argv[si + 1];
const args = argv.slice(si + 2);
const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const write = (s) => fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

if (args[0] === '--version') {
  console.log('9.9.9-fake\n0000000\nx64');
} else if (args[0] === 'agent' && args[1] === 'ps') {
  const s = read();
  const hosts = s.hostPid && alive(s.hostPid)
    ? [{ host: { type: 'standalone', pid: s.hostPid, address: `localhost:${s.port}` }, sessions: s.activeSessions ?? [] }]
    : [];
  console.log(JSON.stringify(hosts));
} else if (args[0] === 'agent' && args[1] === 'host') {
  const opt = (n) => args[args.indexOf(n) + 1];
  const port = Number(opt('--port'));
  const token = fs.readFileSync(opt('--connection-token-file'), 'utf8').trim();
  const s = read();
  const dir = path.dirname(stateFile);
  const server = await startFakeAhp({
    port, token, sessionUri: s.ahpSession, workingDirectories: [s.repoUri],
    onTurn: (a) => fs.appendFileSync(path.join(dir, 'received.jsonl'), JSON.stringify(a) + '\n'),
  });
  // The fake copilot-runtime: a child that holds the session lock until the host tree is killed.
  const rt = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(s.sessionDir, `inuse.${rt.pid}.lock`), '');
  fs.writeFileSync(path.join(dir, `host-env-${process.pid}.json`), JSON.stringify(Object.keys(process.env)));
  write({ ...read(), hostPid: process.pid, runtimePid: rt.pid, starts: (s.starts ?? 0) + 1 });
  console.log(`Agent host listening on http://localhost:${server.port}/?tkn=${token}`);
  process.on('SIGTERM', () => { rt.kill(); process.exit(0); });
} else {
  console.error(`fake-code: unsupported ${args.join(' ')}`);
  process.exit(2);
}
