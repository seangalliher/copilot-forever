// Ralph mode for the goal loop: instead of one long-lived Orchestrator session, run a fresh
// non-interactive `copilot -p` Orchestrator per step (plan, file issues, or one batch), and repeat
// until the queue is empty, the STOP file exists, a cap is hit, or runs stop making progress.
// Needs only the Copilot CLI, gh and git: no standalone host, no log trim, no AHP client.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveGoalLoopConfig } from './goal-loop.mjs';
import { killTree, run, winWrap } from './proc.mjs';
import { exists, nowIso, Refusal, sleep, stampUtc } from './util.mjs';

const GL = '.goal-loop';
export const paths = (repo) => ({
  config: path.join(repo, GL, 'config.json'),
  stop: path.join(repo, GL, 'STOP'),
  plan: path.join(repo, GL, 'PLAN.md'),
  approval: path.join(repo, GL, 'PLAN.approved.json'),
  handoff: path.join(repo, GL, 'handoff.md'),
  dir: path.join(repo, GL, 'ralph'),
  runLog: path.join(repo, GL, 'ralph', 'runs.jsonl'),
});

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fileHash = (file) => (exists(file) ? sha256(file) : null);

export function loadRepoConfig(repo) {
  const p = paths(repo);
  if (!exists(p.config)) throw new Refusal(`${p.config} not found; run the bootstrap for this repository first`, 2);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p.config, 'utf8')); } catch (e) { throw new Refusal(`cannot parse ${p.config}: ${e.message}`, 2); }
  return resolveGoalLoopConfig(raw);
}

/** Record the human's approval of the current PLAN.md (bound to its hash). */
export function approvePlan(repo, log) {
  const p = paths(repo);
  if (!exists(p.plan)) throw new Refusal(`no plan yet: ${p.plan} does not exist (run the loop once to have the Architect write it)`, 2);
  const rec = { sha256: sha256(p.plan), approvedAt: nowIso(), approvedBy: os.userInfo().username };
  fs.writeFileSync(p.approval, JSON.stringify(rec, null, 2) + '\n');
  const issues = (fs.readFileSync(p.plan, 'utf8').match(/^#{2,4} .+$/gm) ?? []).length;
  log.info(`plan approved (${issues} headings, sha256 ${rec.sha256.slice(0, 12)}); the next loop run files the issues`);
  return rec;
}

/** True only if the approval matches PLAN.md as it is now. */
export function planApproved(repo) {
  const p = paths(repo);
  try {
    const a = JSON.parse(fs.readFileSync(p.approval, 'utf8'));
    return exists(p.plan) && a.sha256 === sha256(p.plan);
  } catch {
    return false;
  }
}

/** Queue snapshot from GitHub: goal-loop issues (all states) and goal-loop PRs. */
export async function snapshot(cfg, repo) {
  const [gh, ...lead] = cfg.ralph.ghCommand;
  const q = async (args) => {
    const r = await run(gh, [...lead, ...args], { cwd: repo, timeoutMs: 120000 });
    if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed (exit ${r.code}): ${(r.stderr || r.error?.message || '').trim().slice(0, 300)}`);
    return JSON.parse(r.stdout || '[]');
  };
  const issues = await q(['issue', 'list', '--label', cfg.github.labels.queue, '--state', 'all', '--limit', '500', '--json', 'number,state,labels,updatedAt']);
  const prs = (await q(['pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,state,updatedAt,headRefName']))
    .filter((p) => String(p.headRefName ?? '').startsWith(cfg.github.branchPrefix));
  return { issues, prs };
}

const labelNames = (i) => (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).sort().join(',');

/** Issue and PR numbers whose state, labels or update time changed between two snapshots. */
export function changes(before, after) {
  const key = (i) => `${i.state}|${i.updatedAt}|${labelNames(i)}`;
  const diff = (a, b) => {
    const prev = new Map(a.map((i) => [i.number, key(i)]));
    return b.filter((i) => prev.get(i.number) !== key(i)).map((i) => i.number);
  };
  return { issues: diff(before.issues, after.issues), prs: diff(before.prs, after.prs) };
}

/** What the next run should do. */
export function nextPhase(cfg, repo, snap) {
  const p = paths(repo);
  if (exists(p.stop)) return { phase: 'stop', reason: `stop file ${GL}/STOP exists` };
  if (!snap.issues.length) {
    if (planApproved(repo)) return { phase: 'file' };
    if (exists(p.plan)) {
      return { phase: 'stop', reason: `waiting for plan approval: read ${GL}/PLAN.md, then run \`copilot-forever loop approve-plan\` (or edit it and run the loop again to have it revised)`, awaitingApproval: true };
    }
    return { phase: 'plan' };
  }
  const parked = cfg.github.labels.needsHuman;
  const open = snap.issues.filter((i) => String(i.state).toUpperCase() === 'OPEN');
  const workable = open.filter((i) => !labelNames(i).split(',').includes(parked));
  if (!workable.length) {
    return { phase: 'stop', reason: open.length ? `queue done; ${open.length} issue(s) parked with ${parked}` : 'queue done: every goal-loop issue is closed', done: true };
  }
  return { phase: 'batch', open: workable.length };
}

/** The instructions for one run. Written to a file; the -p prompt only points at it. */
export function promptText(cfg, phase, iteration) {
  const head = `# Ralph mode, run ${iteration}: phase ${phase}

You are the Orchestrator (\`.github/agents/orchestrator.agent.md\`) running as **one run of a Ralph loop**: a fresh, non-interactive session that does one step and ends. A runner starts the next run. Follow your agent file and the standing orders, with the changes below. There is no human in this session: never wait for an answer, never arm watchdogs to wait for merges, and end your turn when this step is done.

First, check \`.goal-loop/STOP\`; if it exists, append a handoff addendum and end.
`;
  const tail = `
Before you end: append a handoff addendum to \`.goal-loop/handoff.md\` (template at its top) saying what this run did and the exact next step, so the next run can start from it alone. End with a short summary: what you did, issues and PRs touched, the gate result, and what the next run should do.
`;
  const body = {
    plan: `
## This run: plan

Follow **Phase 1** up to the plan: delegate goal intake to the Architect (model \`${cfg.models.architect}\`) so it writes \`.goal-loop/PLAN.md\`. Do **not** file any issue. The human reviews the plan outside this session and approves it with \`copilot-forever loop approve-plan\`; an \`Approved:\` line you write yourself does not count.
`,
    file: `
## This run: file the issues

The human approved \`.goal-loop/PLAN.md\` (the runner checked \`.goal-loop/PLAN.approved.json\` against the plan's hash). Record \`Approved: <UTC time>\` at the top of \`PLAN.md\` if missing, then delegate **file-issues** to the Architect (model \`${cfg.models.architect}\`): at most ${cfg.caps.maxIssuesPerPlan} issues, labelled \`${cfg.github.labels.queue}\`. Do not start building in this run.
`,
    batch: `
## This run: one batch

Read the latest addendum in \`.goal-loop/handoff.md\`, then the open \`${cfg.github.labels.queue}\` issues. Complete **at most one batch** by **Phase 2** of your agent file: Builder (\`${cfg.models.builder}\`), focused tests, Diff Reviewer (\`${cfg.models.reviewer}\`, fallback \`${cfg.models.reviewerFallback}\`), review rounds (park after round ${cfg.caps.maxReviewRounds}), one gate with \`node .goal-loop/gate.mjs\`, push the branch, one PR, merge policy \`${cfg.github.mergePolicy}\`, verified closure.

If a batch from an earlier run is half done (see the handoff), finish that one instead of starting another. If no batch can start, because every remaining issue depends on an unmerged PR or is parked, say so in the handoff and end without changes. Do not start a second batch.
`,
  }[phase];
  return head + body + tail;
}

/** The copilot command line for one run (pinned agent and model). */
export function copilotArgs(cfg, { promptRel, usageFile, shareFile }) {
  const r = cfg.ralph;
  const prompt = `Ralph mode: read ${promptRel} and follow it exactly.`;
  if (/["%^&|<>\r\n]/.test(prompt)) throw new Error('internal: the -p prompt must stay free of shell metacharacters');
  return [
    '-p', prompt,
    '--agent', r.agent,
    '--model', cfg.models.orchestrator,
    '--allow-all-tools',
    '--no-ask-user',
    '--no-auto-update',
    ...r.denyTools.map((t) => `--deny-tool=${t}`),
    ...(cfg.github.mergePolicy === 'human' ? ['--deny-tool=shell(gh pr merge)'] : []),
    ...(r.maxAiCreditsPerRun ? ['--max-ai-credits', String(r.maxAiCreditsPerRun)] : []),
    '--usage-output-file', usageFile,
    '--share', shareFile,
    ...r.extraArgs,
  ];
}

// Variables from whatever started the runner that should not reach the agent's shells.
const ENV_DROP = [/^CLAUDECODE$/, /^CLAUDE_CODE_/, /^VSCODE_IPC_HOOK/, /^ELECTRON_RUN_AS_NODE$/, /^NODE_OPTIONS$/];
export const agentEnv = (src = process.env) => Object.fromEntries(Object.entries(src).filter(([k]) => !ENV_DROP.some((re) => re.test(k))));

function runCopilot(cfg, repo, args, logFile, timeoutMs) {
  const [cmd, ...lead] = cfg.ralph.copilotCommand;
  const [file, fileArgs, opts] = winWrap(cmd, [...lead, ...args]);
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, 'a');
    let child;
    try {
      child = spawn(file, fileArgs, { cwd: repo, env: agentEnv(), stdio: ['ignore', out, out], windowsHide: true, ...opts });
    } catch (e) {
      fs.closeSync(out);
      resolve({ code: null, error: e.message });
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); fs.closeSync(out); resolve({ code: null, error: e.message }); });
    child.on('exit', (code) => { clearTimeout(timer); fs.closeSync(out); resolve({ code, timedOut }); });
  });
}

/**
 * The Ralph loop.
 * @param {{ repo: string, log: any, dryRun?: boolean, maxIterations?: number }} o
 * @returns {Promise<{ stop: string, iterations: number, exitCode: number }>}
 */
export async function ralphLoop(o) {
  const repo = path.resolve(o.repo);
  const { log, dryRun = false } = o;
  const cfg = loadRepoConfig(repo);
  const p = paths(repo);
  const maxIterations = o.maxIterations ?? cfg.ralph.maxIterations;
  if (!dryRun) fs.mkdirSync(p.dir, { recursive: true });
  let stall = 0;
  let batches = 0;
  let iteration = 0;
  let snap = await snapshot(cfg, repo);
  const finish = (stop, exitCode = 0) => {
    log.info(`loop ends: ${stop} (${iteration} run${iteration === 1 ? '' : 's'}, ${batches} batch run${batches === 1 ? '' : 's'})`);
    return { stop, iterations: iteration, exitCode };
  };

  for (;;) {
    const next = nextPhase(cfg, repo, snap);
    if (next.phase === 'stop') return finish(next.reason, 0);
    if (iteration >= maxIterations) return finish(`cap: ${maxIterations} runs (ralph.maxIterations)`, 0);
    if (next.phase === 'batch' && batches >= cfg.caps.maxBatchesPerRun) return finish(`cap: ${batches} batch runs (caps.maxBatchesPerRun)`, 0);
    iteration++;
    const stamp = stampUtc();
    const base = `run-${String(iteration).padStart(3, '0')}-${next.phase}-${stamp}`;
    const promptRel = `${GL}/ralph/${base}.prompt.md`;
    const files = {
      prompt: path.join(repo, promptRel),
      log: path.join(p.dir, `${base}.log`),
      usage: path.join(p.dir, `${base}.usage.json`),
      share: path.join(p.dir, `${base}.transcript.md`),
    };
    const args = copilotArgs(cfg, { promptRel, usageFile: files.usage, shareFile: files.share });
    const shown = [...cfg.ralph.copilotCommand, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
    if (dryRun) {
      log.info(`run ${iteration}: phase ${next.phase}${next.open ? ` (${next.open} workable issues)` : ''}`);
      log.info(`would write ${promptRel}:\n${promptText(cfg, next.phase, iteration)}`);
      log.info(`would run (in ${repo}): ${shown}`);
      return finish(`dry run: stopped before run ${iteration}`, 0);
    }
    fs.writeFileSync(files.prompt, promptText(cfg, next.phase, iteration));
    const planBefore = fileHash(p.plan);
    const handoffBefore = fileHash(p.handoff);
    const startedAt = nowIso();
    log.info(`run ${iteration}: phase ${next.phase} started; output ${path.relative(repo, files.log)}`);
    const res = await runCopilot(cfg, repo, args, files.log, cfg.ralph.iterationTimeoutMinutes * 60000);
    const endedAt = nowIso();
    if (res.error) {
      appendRunLog(p.runLog, { iteration, phase: next.phase, startedAt, endedAt, exitCode: null, error: res.error, log: path.relative(repo, files.log) });
      return finish(`cannot run ${cfg.ralph.copilotCommand[0]}: ${res.error}`, 1);
    }
    let after;
    try {
      after = await snapshot(cfg, repo);
    } catch (e) {
      appendRunLog(p.runLog, { iteration, phase: next.phase, startedAt, endedAt, exitCode: res.code, error: e.message });
      return finish(`cannot read the queue after run ${iteration}: ${e.message}`, 1);
    }
    const ch = changes(snap, after);
    const planChanged = fileHash(p.plan) !== planBefore;
    const progress = ch.issues.length > 0 || ch.prs.length > 0 || (next.phase === 'plan' && planChanged);
    const entry = {
      iteration, phase: next.phase, startedAt, endedAt, exitCode: res.code, timedOut: !!res.timedOut,
      issuesTouched: ch.issues, prsTouched: ch.prs, planChanged, handoffUpdated: fileHash(p.handoff) !== handoffBefore,
      openBefore: snap.issues.filter((i) => String(i.state).toUpperCase() === 'OPEN').length,
      openAfter: after.issues.filter((i) => String(i.state).toUpperCase() === 'OPEN').length,
      progress, log: path.relative(repo, files.log).replace(/\\/g, '/'),
    };
    appendRunLog(p.runLog, entry);
    log.info(`run ${iteration}: exit ${res.code}${res.timedOut ? ' (timed out)' : ''}; issues touched ${ch.issues.join(', ') || 'none'}; PRs ${ch.prs.join(', ') || 'none'}; open ${entry.openBefore} -> ${entry.openAfter}${progress ? '' : '; NO PROGRESS'}`);
    if (next.phase === 'batch') batches++;
    stall = progress ? 0 : stall + 1;
    snap = after;
    if (stall >= cfg.ralph.stallLimit) return finish(`stalled: ${stall} runs in a row made no progress (ralph.stallLimit); see ${path.relative(repo, p.runLog)}`, 1);
    if (next.phase === 'plan') continue; // the next phase check stops for approval
    if (cfg.ralph.pauseSeconds) await sleep(cfg.ralph.pauseSeconds * 1000);
  }
}

function appendRunLog(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}
