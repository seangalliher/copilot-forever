// Timing report for a goal-loop session: where the wall-clock time went, per role and per
// subagent run, with effort, tokens, tool time and Copilot's own usage figures.
//
// Reads the session's events.jsonl (streamed: logs can be hundreds of MiB) plus any trim
// archives of the same session, so a trimmed session still reports from its first event.
// Every millisecond of the span is put in exactly one bucket, so the buckets add up to the span.
// Where several apply, the first in this list wins:
//   stopped    - the session was shut down cleanly (session.shutdown to the next resume)
//   agents     - at least one subagent was running (background ones too)
//   waiting    - the session was idle until a message arrived (from you or the watcher; not
//                Copilot's own autopilot nudges), or an ask_user question was open. A stall
//                the watcher ended with a continue shows here, not as quiet (or as agents,
//                if a background subagent was running).
//   orchestrator (busy) - a model call or a compaction was in progress
//   background - a background shell (an async command, such as a watchdog sleep) or a
//                synchronous sleep-only command was running. A shell that never reports
//                completing counts only up to the last time a tool read or stopped it.
//   quiet      - 5+ minutes between the events the report reads with no tool open and none of
//                the above: often a stall, but it can be anything the log does not show
//   orchestrator - everything else: the top-level agent reading, deciding, running tools
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { workspaceCwd } from './session.mjs';
import { readJson, Refusal, samePath } from './util.mjs';

/** A silence this long, with nothing else explaining it, counts as quiet. */
export const IDLE_MS = 5 * 60000;

const KEEP = new Set([
  'session.start', 'session.resume', 'session.shutdown', 'session.usage_checkpoint', 'session.usage_record',
  'session.task_complete', 'session.compaction_start', 'session.compaction_complete', 'system.notification',
  'user.message', 'assistant.turn_end', 'assistant.message',
  'subagent.started', 'subagent.configured', 'subagent.completed', 'subagent.failed',
  'tool.execution_start', 'tool.execution_complete',
]);
// A synchronous command that only sleeps (a watchdog): waiting, not work.
const SLEEP_ONLY = /^\s*(Start-Sleep|sleep)\b[^;&|\n]*$/i;
// Events that mean the session was doing something; the last one before an idle message starts the wait.
const WORK = new Set(['assistant.turn_end', 'assistant.message', 'session.task_complete', 'tool.execution_complete', 'subagent.completed', 'subagent.failed']);

const firstLine = (s, n = 90) => {
  const line = String(s ?? '').split('\n').map((x) => x.trim()).find(Boolean) ?? '';
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

/** Reduce one log event to the few fields the report uses (drops prompts, results, snapshots). */
function slim(e) {
  const d = e.data ?? {};
  const r = { id: e.id, type: e.type, ts: Date.parse(e.timestamp), agentId: e.agentId ?? null };
  switch (e.type) {
    case 'session.start': r.version = d.copilotVersion ?? null; r.sessionId = d.sessionId ?? null; break;
    case 'session.usage_checkpoint': r.nanoAiu = d.totalNanoAiu; r.premium = d.totalPremiumRequests; break;
    case 'session.shutdown': r.nanoAiu = d.accountingSnapshot?.totalNanoAiu; r.premium = d.accountingSnapshot?.totalPremiumRequestCost; break;
    case 'session.usage_record': r.ms = d.usage?.duration ?? 0; r.out = d.usage?.outputTokens ?? 0; r.model = d.usage?.model ?? null; break;
    case 'user.message': r.text = firstLine(d.content); r.idle = d.delivery === 'idle'; r.source = d.source ?? null; break;
    case 'system.notification':
      r.kind = d.kind?.type ?? null; r.shellId = d.kind?.shellId ?? null; break;
    case 'subagent.started':
      // The role is the agent (Builder); the display name may be a per-run label (bf907-review-r1).
      r.call = d.toolCallId; r.role = d.agentType ?? d.agentName ?? d.agentDisplayName; r.name = d.agentDisplayName ?? r.role;
      r.model = d.model ?? null; r.mode = d.executionMode ?? null; break;
    case 'subagent.configured': r.model = d.model ?? null; r.effort = d.reasoningEffort ?? null; break;
    case 'subagent.completed': case 'subagent.failed':
      r.call = d.toolCallId; r.ms = d.durationMs; r.tools = d.totalToolCalls; r.tokens = d.totalTokens; break;
    case 'tool.execution_start': {
      r.call = d.toolCallId; r.tool = d.toolName;
      const a = d.arguments ?? {};
      if (a.mode === 'async' && a.shellId) r.bgShell = a.shellId;
      else if (a.shellId) r.shellRef = a.shellId; // read_powershell / stop_powershell on a shell
      if (typeof a.command === 'string' && SLEEP_ONLY.test(a.command)) r.sleep = true;
      break;
    }
    case 'tool.execution_complete': r.call = d.toolCallId; break;
    default: break;
  }
  return r;
}

/** Stream the given logs, keep the events the report needs, drop duplicates (archives overlap), sort by time. */
export async function readSessionEvents(files) {
  const byId = new Map();
  let bad = 0;
  for (const file of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      // Cheap filter before parsing: most lines are hooks and assistant text.
      const m = /"type":"([a-z_.]+)"/.exec(line.slice(0, 200));
      if (m && !KEEP.has(m[1])) continue;
      let e;
      try { e = JSON.parse(line); } catch { bad++; continue; }
      if (!KEEP.has(e.type) || !e.timestamp) continue;
      const s = slim(e);
      if (Number.isNaN(s.ts)) continue;
      byId.set(s.id ?? `${file}:${byId.size}`, s);
    }
  }
  const events = [...byId.values()].sort((a, b) => a.ts - b.ts);
  return { events, unreadable: bad };
}

/**
 * Credit each stretch of [t0, tEnd] to the highest-priority layer with an interval open over it,
 * or to the orchestrator when none is. One pass over sorted edges: O(n log n) in the intervals.
 * @param {Array<[string, number[][]]>} layers @param {number} t0 @param {number} tEnd @param {Record<string, number>} buckets
 */
function sweep(layers, t0, tEnd, buckets) {
  const edges = [];
  layers.forEach(([, ivs], i) => {
    for (const [a, b] of ivs) {
      const x = Math.max(t0, a); const y = Math.min(tEnd, b);
      if (y > x) edges.push([x, i, 1], [y, i, -1]);
    }
  });
  edges.sort((p, q) => p[0] - q[0]);
  const open = new Array(layers.length).fill(0);
  let prev = t0;
  const credit = (to) => {
    if (to <= prev) return;
    const i = open.findIndex((c) => c > 0);
    buckets[i === -1 ? 'orchestrator' : layers[i][0]] += to - prev;
    prev = to;
  };
  for (const [t, i, d] of edges) { credit(t); open[i] += d; }
  credit(tEnd);
}

/** The pure analysis: buckets, per-run rows, per-role totals and usage. */
export function analyze(events) {
  if (!events.length) throw new Refusal('the session log has no events the report can use', 3);
  const t0 = events[0].ts;
  const tEnd = events[events.length - 1].ts;
  const runs = new Map(); // toolCallId -> run
  const byAgent = new Map(); // agentId -> run
  const toolStart = new Map();
  const model = new Map(); // agentId|'' -> ms
  const toolMs = new Map(); const sleepMs = new Map();
  const waits = []; const stops = []; const busy = []; const bg = [];
  const idles = []; const openTools = new Map(); let prevTs = null; // tool call -> agentId|''
  // Async shells not yet reported done: shellId -> { start, seen }. A shell that never reports
  // completing counts only up to the last time a tool touched it, so it cannot hide a stall.
  const shells = new Map();
  const closeShell = (id, end) => {
    const s = shells.get(id);
    if (!s) return;
    if (end > s.start) bg.push([s.start, end]);
    shells.delete(id);
  };
  let compactAt = null;
  let lastWork = null; let shutdownAt = null; let version = null; let sessionId = null;
  let nanoAiu = null; let premium = null; let apiMs = 0; let outTokens = 0;
  const add = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v);

  for (const e of events) {
    const who = e.agentId ?? '';
    // A long silence with no tool open is quiet, unless a layer above explains it.
    if (prevTs != null && e.ts - prevTs >= IDLE_MS && openTools.size === 0) idles.push([prevTs, e.ts]);
    prevTs = e.ts;
    if (e.agentId && byAgent.has(e.agentId)) byAgent.get(e.agentId).last = e.ts;
    switch (e.type) {
      case 'session.start': version ??= e.version; sessionId ??= e.sessionId; break;
      case 'session.shutdown':
        shutdownAt = e.ts;
        if (e.nanoAiu != null) nanoAiu = Math.max(nanoAiu ?? 0, e.nanoAiu);
        if (e.premium != null) premium = Math.max(premium ?? 0, e.premium);
        break;
      case 'session.resume':
        if (shutdownAt != null) stops.push([shutdownAt, e.ts]);
        shutdownAt = null;
        // Tools and shells cut off by a shutdown never complete; don't let them hold state forever.
        openTools.clear();
        for (const [id, s] of [...shells]) closeShell(id, s.seen);
        // Subagents running at the shutdown did not survive it: end them at their last event.
        for (const run of runs.values()) {
          if (run.end == null) { run.end = run.last; run.status = 'cut off'; }
        }
        break;
      case 'session.compaction_start': compactAt ??= e.ts; break;
      case 'session.compaction_complete':
        if (compactAt != null) busy.push([compactAt, e.ts]);
        compactAt = null;
        break;
      case 'system.notification':
        if (e.kind === 'shell_completed' || e.kind === 'shell_detached_completed') closeShell(e.shellId, e.ts);
        break;
      case 'session.usage_checkpoint':
        if (e.nanoAiu != null) nanoAiu = Math.max(nanoAiu ?? 0, e.nanoAiu);
        if (e.premium != null) premium = Math.max(premium ?? 0, e.premium);
        break;
      case 'session.usage_record':
        add(model, who, e.ms); apiMs += e.ms; outTokens += e.out;
        if (e.ms > 0) busy.push([e.ts - e.ms, e.ts]); // the call ran up to this record
        break;
      case 'subagent.started': {
        const run = { name: e.name, role: e.role ?? e.name, start: e.ts, end: null, last: e.ts, agentId: e.agentId, model: e.model, effort: null, mode: e.mode, task: '', tools: null, tokens: null, status: 'running' };
        runs.set(e.call, run);
        if (e.agentId) byAgent.set(e.agentId, run);
        break;
      }
      case 'subagent.configured': {
        const run = byAgent.get(e.agentId);
        if (run) { run.effort = e.effort; run.model = e.model ?? run.model; }
        break;
      }
      case 'subagent.completed': case 'subagent.failed': {
        const run = runs.get(e.call);
        if (run) {
          run.end = e.ts; run.tools = e.tools ?? null; run.tokens = e.tokens ?? null;
          run.status = e.type === 'subagent.failed' ? 'failed' : 'done';
        }
        // The subagent is gone: any of its tools that never completed are not running.
        for (const [call, who2] of [...openTools]) if (who2 === e.agentId) openTools.delete(call);
        break;
      }
      case 'user.message': {
        const run = e.agentId ? byAgent.get(e.agentId) : null;
        if (run && !run.task) run.task = e.text;
        // A top-level message that arrived while the session was idle ends a wait. Copilot's own
        // autopilot nudges are not input someone gave.
        if (!e.agentId && e.idle && e.source !== 'autopilot' && lastWork != null && e.ts > lastWork) waits.push([lastWork, e.ts]);
        break;
      }
      case 'tool.execution_start':
        toolStart.set(e.call, e);
        if (e.tool !== 'task') openTools.set(e.call, who);
        if (e.bgShell) {
          const old = shells.get(e.bgShell);
          if (old) closeShell(e.bgShell, old.seen); // an id reused before its completion arrived
          shells.set(e.bgShell, { start: e.ts, seen: e.ts });
        }
        if (e.shellRef && shells.has(e.shellRef)) {
          // read_powershell and stop_powershell touch the shell; a new synchronous command that
          // reuses its id means the old shell is long gone.
          if (e.tool === 'powershell') closeShell(e.shellRef, shells.get(e.shellRef).seen);
          else shells.get(e.shellRef).seen = e.ts;
        }
        break;
      case 'tool.execution_complete': {
        openTools.delete(e.call);
        const s = toolStart.get(e.call);
        toolStart.delete(e.call);
        if (s && s.tool !== 'task') {
          if (s.tool === 'ask_user' && !s.agentId) waits.push([s.ts, e.ts]);
          else if (s.sleep) { add(sleepMs, s.agentId ?? '', e.ts - s.ts); if (!s.agentId) bg.push([s.ts, e.ts]); }
          else add(toolMs, s.agentId ?? '', e.ts - s.ts);
        }
        break;
      }
      default: break;
    }
    if (WORK.has(e.type) && !e.agentId) lastWork = e.ts;
  }
  if (shutdownAt != null && shutdownAt < tEnd) stops.push([shutdownAt, tEnd]);
  if (compactAt != null) busy.push([compactAt, tEnd]);
  for (const [id, s] of [...shells]) closeShell(id, s.seen);
  for (const run of runs.values()) run.end ??= tEnd;

  const buckets = { agents: 0, orchestrator: 0, background: 0, waiting: 0, quiet: 0, stopped: 0 };
  /** @type {Array<[keyof typeof buckets, number[][]]>} highest priority first */
  const layers = [
    ['stopped', stops],
    ['agents', [...runs.values()].map((r) => [r.start, r.end])],
    ['waiting', waits],
    ['orchestrator', busy],
    ['background', bg],
    ['quiet', idles],
  ];
  sweep(layers, t0, tEnd, buckets);

  const rows = [...runs.values()].sort((a, b) => a.start - b.start).map((r) => ({
    name: r.name, role: r.role, offsetMs: r.start - t0, wallMs: r.end - r.start, modelMs: model.get(r.agentId) ?? 0, toolMs: toolMs.get(r.agentId) ?? 0,
    sleepMs: sleepMs.get(r.agentId) ?? 0, tools: r.tools, tokens: r.tokens, model: r.model, effort: r.effort, mode: r.mode, status: r.status, task: r.task,
  }));
  const roles = new Map();
  for (const r of rows) {
    const x = roles.get(r.role) ?? { name: r.role, runs: 0, wallMs: 0, modelMs: 0, toolMs: 0, sleepMs: 0, tokens: 0, models: new Set(), efforts: new Set() };
    x.runs++; x.wallMs += r.wallMs; x.modelMs += r.modelMs; x.toolMs += r.toolMs; x.sleepMs += r.sleepMs; x.tokens += r.tokens ?? 0;
    if (r.model) x.models.add(r.model);
    if (r.effort) x.efforts.add(r.effort);
    roles.set(r.role, x);
  }
  const roleRows = [...roles.values()].sort((a, b) => b.wallMs - a.wallMs)
    .map((x) => ({ ...x, models: [...x.models], efforts: [...x.efforts] }));
  roleRows.push({ name: 'Orchestrator (top level)', runs: null, wallMs: buckets.orchestrator, modelMs: model.get('') ?? 0, toolMs: toolMs.get('') ?? 0, sleepMs: sleepMs.get('') ?? 0, tokens: null, models: [], efforts: [] });

  return {
    sessionId, version, start: new Date(t0).toISOString(), end: new Date(tEnd).toISOString(), spanMs: tEnd - t0,
    buckets, roles: roleRows, runs: rows,
    reviewRuns: rows.filter((r) => /review/i.test(r.role ?? '')).length,
    waits: waits.length,
    usage: { premiumRequests: premium, aiUnits: nanoAiu == null ? null : nanoAiu / 1e9, modelApiMs: apiMs, outputTokens: outTokens },
  };
}

export function fmtMs(ms) {
  if (ms == null) return '–';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}
const fmtTok = (n) => (n == null ? '–' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
const offset = (ms) => {
  const m = Math.floor(ms / 60000);
  return `+${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};

/** Commits from `git log --shortstat --format=@@%H`: one { sha, files, added, removed } each. */
export function parseShortstat(text) {
  const commits = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.startsWith('@@')) { commits.push({ sha: line.slice(2).trim(), files: 0, added: 0, removed: 0 }); continue; }
    const c = commits[commits.length - 1];
    if (!c || !/\bchanged\b/.test(line)) continue;
    const n = (re) => Number(re.exec(line)?.[1] ?? 0);
    c.files = n(/(\d+) files? changed/); c.added = n(/(\d+) insertions?\(\+\)/); c.removed = n(/(\d+) deletions?\(-\)/);
  }
  return commits;
}

/** Totals and the lines changed (added plus removed) per commit: median and largest. */
export function summarizeChanges(commits) {
  const sum = (k) => commits.reduce((a, c) => a + c[k], 0);
  const lines = commits.map((c) => c.added + c.removed).sort((a, b) => a - b);
  const mid = lines.length >> 1;
  const median = !lines.length ? null : lines.length % 2 ? lines[mid] : (lines[mid - 1] + lines[mid]) / 2;
  return { commits: commits.length, files: sum('files'), added: sum('added'), removed: sum('removed'), medianLines: median, largestLines: lines.at(-1) ?? null };
}

/**
 * What the loop committed in `repo` between two times: commits on any local branch or in the
 * reflog (so branches deleted after merging still count), without merges, and only those whose
 * committer is the repository's own user.email (so GitHub's squash-merge commits are left out).
 * Only changes under `repo` count, so a folder inside a larger repository reports its own.
 * Null when `repo` is not in a git work tree; `{ repo, error }` when git fails there.
 * @returns {any}
 */
export function gitChanges(repo, startIso, endIso, env = process.env) {
  // LC_ALL=C: the --shortstat line is parsed by its English words.
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...env, LC_ALL: 'C' } });
  const top = git('rev-parse', '--is-inside-work-tree');
  if (top.stdout?.trim() === 'false') return null; // a bare repository or a .git folder
  if (top.stdout?.trim() !== 'true') {
    if (!top.error && /not a git repository/i.test(top.stderr ?? '')) return null;
    return { repo, error: firstLine(top.error?.message ?? top.stderr) || `git exited with ${top.status}` };
  }
  const email = git('config', 'user.email');
  const committer = email.status === 0 && email.stdout.trim() ? email.stdout.trim() : null;
  const who = committer ? ['--fixed-strings', `--committer=<${committer}>`] : [];
  const res = git('log', '--branches', '--reflog', '--no-merges', ...who, `--since=${startIso}`, `--until=${endIso}`, '--shortstat', '--format=@@%H', '--', '.');
  if (res.status !== 0) return { repo, error: firstLine(res.error?.message ?? res.stderr) || `git exited with ${res.status}` };
  return { repo, committer, ...summarizeChanges(parseShortstat(res.stdout)) };
}

/** Markdown for people: the summary first, then per role, then every subagent run. */
export function renderMarkdown(r, { source = [] } = {}) {
  const b = r.buckets;
  const L = [];
  L.push('# Goal-loop timing report', '');
  L.push(`Session \`${r.sessionId ?? 'unknown'}\`${r.version ? `, Copilot ${r.version}` : ''}: ${r.start} to ${r.end}, **${fmtMs(r.spanMs)}** in all.`, '');
  L.push('## Where the time went', '');
  L.push('| | Time | Share |', '|---|---:|---:|');
  const row = (label, ms) => L.push(`| ${label} | ${fmtMs(ms)} | ${pct(ms, r.spanMs)} |`);
  row('Agents working (subagents)', b.agents);
  row('Orchestrator between agents', b.orchestrator);
  row(`Waiting for a message or an answer, from you or the watcher (${r.waits} time${r.waits === 1 ? '' : 's'})`, b.waiting);
  if (b.background) row('Waiting on background commands or sleeps', b.background);
  if (b.quiet) row('Quiet: 5+ min with nothing in the log explaining it (often a stall)', b.quiet);
  if (b.stopped) row('Session stopped', b.stopped);
  L.push('');
  L.push('## By role', '');
  L.push('| Role | Runs | Wall time | Model time | Tool time | Sleeps | Tokens | Effort | Model |', '|---|---:|---:|---:|---:|---:|---:|---|---|');
  for (const x of r.roles) {
    L.push(`| ${cell(x.name)} | ${x.runs ?? '–'} | ${fmtMs(x.wallMs)} | ${fmtMs(x.modelMs)} | ${fmtMs(x.toolMs)} | ${fmtMs(x.sleepMs)} | ${fmtTok(x.tokens)} | ${cell(x.efforts.join(', ') || '–')} | ${cell(x.models.join(', ') || '–')} |`);
  }
  L.push('');
  L.push('Wall time sums the role\'s runs, so runs that overlapped (background subagents) count more than once; the table above does not. ' +
    'Model time sums the role\'s model calls; tool time its tool runs, without commands that only sleep (Sleeps). ' +
    'Tokens are each call\'s input (cached or not) plus its output, summed over calls.', '');
  L.push('## Every subagent run', '');
  L.push('| Start | Agent | Wall | Model | Tools | Tokens | Effort | Task |', '|---|---|---:|---:|---:|---:|---|---|');
  for (const x of r.runs) {
    const name = x.status === 'done' ? x.name : `${x.name} (${x.status})`;
    L.push(`| ${offset(x.offsetMs)} | ${cell(name)} | ${fmtMs(x.wallMs)} | ${fmtMs(x.modelMs)} | ${x.tools ?? '–'} | ${fmtTok(x.tokens)} | ${cell(x.effort ?? '–')} | ${cell(x.task)} |`);
  }
  L.push('');
  L.push('## Usage', '');
  const u = r.usage;
  L.push(`- Diff Reviewer runs: ${r.reviewRuns}`);
  L.push(`- Model API time: ${fmtMs(u.modelApiMs)}; output tokens: ${fmtTok(u.outputTokens)}`);
  if (u.premiumRequests != null) L.push(`- Premium requests: ${u.premiumRequests}`);
  if (u.aiUnits != null) L.push(`- AI units (Copilot's \`totalNanoAiu\` ÷ 10⁹): ${u.aiUnits.toFixed(1)}`);
  L.push('', 'The span ends at the last event in the log: a session still running is reported up to its latest event. "Session stopped" covers only a clean shutdown; a killed host shows as quiet, or as Orchestrator if a tool was running when it died. ' +
    'A stall the watcher ended with a continue counts as waiting for a message, unless a background subagent was running; then it counts as agents working. ' +
    'The count of waits includes waits that a running subagent covered, which add no time to that row.');
  const c = r.changes;
  if (c) {
    L.push('', '## Changes', '');
    if (c.error) L.push(`Unavailable: git failed in \`${c.repo}\`: ${c.error}`);
    else if (!c.commits) L.push(`No commits${c.committer ? ` by ${c.committer}` : ''} in this span.`);
    else {
      L.push(`- Commits: ${c.commits}, ${c.files} file changes, +${c.added} −${c.removed} lines`);
      L.push(`- Lines changed per commit (added plus removed): median ${c.medianLines}, largest ${c.largestLines}`);
      L.push(`- Diff Reviewer runs in the session per commit counted here: ${(r.reviewRuns / c.commits).toFixed(1)}`);
    }
    if (!c.error) {
      L.push('', `From \`git log\` in \`${c.repo}\` (changes under that folder only): commits made in the session's span on any local branch or in the reflog, without merges, ` +
        (c.committer ? `whose committer is ${c.committer} (the repository's user.email). ` : 'from any committer (the repository has no user.email, so GitHub\'s squash-merge commits count too). ') +
        'An amended or rebased commit counts again; commits made by hand in the span count too.');
    }
  }
  if (source.length) L.push('', `Source: ${source.map((s) => `\`${s}\``).join(', ')}`);
  L.push('');
  return L.join('\n');
}

/**
 * The log files of one session: its events.jsonl plus any trim archives of it.
 * `session` may be a session id, a session folder or an events.jsonl path; without it, the
 * session in the watcher's status file, else the newest session whose workspace is the repo.
 * @param {any} cfg  may be null when `session` is a path
 */
export function sessionFiles(cfg, session) {
  let id = null; let file = null;
  if (session && fs.existsSync(session)) {
    const st = fs.statSync(session);
    file = st.isDirectory() ? path.join(session, 'events.jsonl') : session;
    id = path.basename(st.isDirectory() ? session : path.dirname(session));
  } else if (session) {
    if (!cfg) {
      throw new Refusal(/[\\/]/.test(session)
        ? `no session folder or file at ${session}`
        : `no config to find session ${session} with: pass --config, or the session's folder or events.jsonl path`, 2);
    }
    id = session;
  } else {
    if (!cfg) throw new Refusal('pass --session <id or events.jsonl path>, or a config', 2);
    try { id = readJson(cfg.files.status).session_id ?? null; } catch { /* no status file */ }
    if (!id) id = newestRepoSession(cfg);
    if (!id) throw new Refusal(`no session found for ${cfg.repoFolder}; pass --session <id>`, 3);
  }
  if (!file) file = path.join(cfg.sessionStateDir, id, 'events.jsonl');
  if (!fs.existsSync(file)) throw new Refusal(`no session log at ${file}`, 3);
  const files = [];
  // Without a config, trim archives are in the default place (<COPILOT_HOME or ~/.copilot>/session-archive).
  const archRoot = cfg?.trim?.archiveDir ?? path.join(process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'), 'session-archive');
  const archDir = path.join(archRoot, id);
  if (fs.existsSync(archDir)) {
    for (const n of fs.readdirSync(archDir).sort()) if (/^events-.*\.jsonl$/.test(n)) files.push(path.join(archDir, n));
  }
  files.push(file);
  return files;
}

function newestRepoSession(cfg) {
  let best = null;
  let dirs = [];
  try { dirs = fs.readdirSync(cfg.sessionStateDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return null; }
  for (const d of dirs) {
    const dir = path.join(cfg.sessionStateDir, d.name);
    const cwd = workspaceCwd(dir);
    if (!cwd || !samePath(cwd, cfg.repoFolder)) continue;
    let mtime;
    try { mtime = fs.statSync(path.join(dir, 'events.jsonl')).mtimeMs; } catch { continue; }
    if (!best || mtime > best.mtime) best = { id: d.name, mtime };
  }
  return best?.id ?? null;
}

/** Read, analyze and render; returns the text written (markdown or JSON). */
export async function report(cfg, { session = undefined, json = false, out = undefined } = {}) {
  const files = sessionFiles(cfg, session);
  const { events, unreadable } = await readSessionEvents(files);
  const r = analyze(events);
  // Lines changed: in the config's repository, or else the session's own workspace folder.
  // A configured folder that is missing is reported as an error; a vanished workspace folder is skipped.
  const ws = cfg?.repoFolder ? null : workspaceCwd(path.dirname(files[files.length - 1]));
  const repo = cfg?.repoFolder ?? (ws && fs.existsSync(ws) ? ws : null);
  r.changes = repo && events.length ? gitChanges(repo, r.start, r.end) : null;
  const text = json ? `${JSON.stringify({ ...r, unreadableLines: unreadable, source: files }, null, 2)}\n` : renderMarkdown(r, { source: files });
  if (out) fs.writeFileSync(out, text);
  return { text, report: r, files, unreadable };
}
