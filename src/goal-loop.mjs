// goal-loop bootstrap: render templates/goal-loop into a target repository and set up
// copilot-forever for it. Used by bootstrap.mjs and `copilot-forever goal-loop`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './proc.mjs';
import { exists, Refusal } from './util.mjs';

export const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATES = path.join(KIT_ROOT, 'templates', 'goal-loop');
const EXAMPLE = path.join(TEMPLATES, 'goal-loop.config.example.json');
export const MERGE_POLICIES = ['human', 'agent-after-green'];

/** Model family from a model id: the vendor whose models share blind spots. */
export function modelFamily(id) {
  const m = String(id).toLowerCase().trim();
  if (/^(gpt|o\d|codex|chatgpt)/.test(m)) return 'openai';
  if (/^claude/.test(m)) return 'anthropic';
  if (/^gemini|^gemma/.test(m)) return 'google';
  if (/^grok/.test(m)) return 'xai';
  return m.split(/[-_.:/ ]/)[0];
}

function merge(base, over) {
  if (over === undefined) return base;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

export function defaultGoalLoopConfig() {
  return JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
}

/** Merge a user config over the defaults and validate it. */
export function resolveGoalLoopConfig(raw = {}, { allowSameFamily = false } = {}) {
  const cfg = merge(defaultGoalLoopConfig(), raw);
  const p = [];
  for (const role of ['orchestrator', 'architect', 'builder', 'reviewer']) {
    if (typeof cfg.models[role] !== 'string' || !cfg.models[role].trim()) p.push(`models.${role} must be a model id`);
  }
  if (!p.length && !allowSameFamily && modelFamily(cfg.models.reviewer) === modelFamily(cfg.models.builder)) {
    p.push(`models.reviewer (${cfg.models.reviewer}) is the same model family as models.builder (${cfg.models.builder}); a reviewer on the same family shares its blind spots`);
  }
  if (cfg.models.reviewerFallback && !allowSameFamily && modelFamily(cfg.models.reviewerFallback) === modelFamily(cfg.models.builder)) {
    p.push(`models.reviewerFallback (${cfg.models.reviewerFallback}) is the same model family as models.builder`);
  }
  if (typeof cfg.gate.command !== 'string' || !cfg.gate.command.trim()) p.push('gate.command must be the repository\'s full test command');
  for (const [k, v] of Object.entries(cfg.caps)) if (!Number.isInteger(v) || v < 1) p.push(`caps.${k} must be a positive integer`);
  if (cfg.caps.maxBatchSize > 3) p.push('caps.maxBatchSize must be 3 or less');
  if (cfg.caps.maxReviewRounds > 5) p.push('caps.maxReviewRounds must be 5 or less');
  if (!MERGE_POLICIES.includes(cfg.github.mergePolicy)) p.push(`github.mergePolicy must be one of ${MERGE_POLICIES.join(', ')}`);
  if (!/^[A-Za-z0-9._/-]+\/$/.test(cfg.github.branchPrefix)) p.push('github.branchPrefix must end with / (e.g. goal-loop/)');
  for (const k of ['queue', 'inProgress', 'needsHuman']) if (!cfg.github.labels?.[k]) p.push(`github.labels.${k} is required`);
  const r = cfg.ralph;
  for (const k of ['copilotCommand', 'ghCommand']) {
    if (typeof r[k] === 'string') r[k] = [r[k]];
    if (!Array.isArray(r[k]) || !r[k].length || !r[k].every((x) => typeof x === 'string' && x)) p.push(`ralph.${k} must be a command name or an array of strings`);
  }
  if (typeof r.agent !== 'string' || !r.agent) p.push("ralph.agent must be the Orchestrator agent's name");
  for (const k of ['maxIterations', 'stallLimit', 'iterationTimeoutMinutes']) if (!Number.isInteger(r[k]) || r[k] < 1) p.push(`ralph.${k} must be a positive integer`);
  for (const k of ['pauseSeconds', 'maxAiCreditsPerRun']) if (!Number.isInteger(r[k]) || r[k] < 0) p.push(`ralph.${k} must be a non-negative integer`);
  if (r.maxAiCreditsPerRun && r.maxAiCreditsPerRun < 30) p.push('ralph.maxAiCreditsPerRun must be 0 (no limit) or at least 30 (the Copilot CLI minimum)');
  for (const k of ['denyTools', 'extraArgs']) if (!Array.isArray(r[k]) || !r[k].every((x) => typeof x === 'string')) p.push(`ralph.${k} must be an array of strings`);
  if (p.length) throw new Refusal(`invalid goal-loop config:\n  - ${p.join('\n  - ')}`, 2);
  return cfg;
}

/** Replace {{a.b}} placeholders; unknown placeholders are an error. */
export function render(text, vars) {
  return text.replace(/\{\{([A-Za-z0-9_.]+)\}\}/g, (_m, key) => {
    const v = key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), vars);
    if (v === undefined || v === null || (typeof v === 'object')) throw new Error(`template placeholder {{${key}}} has no value`);
    return String(v);
  });
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'repo';

/** The copilot-forever config for the target repo, stored at .goal-loop/copilot-forever.config.json. */
export function keepAliveConfig(cfg, repo) {
  return {
    repoFolder: '..',
    agentFile: '.github/agents/orchestrator.agent.md',
    instanceName: `copilot-forever-${slug(path.basename(repo))}`,
    host: { codeCommand: 'code', port: cfg.keepAlive?.port ?? 47801 },
    trim: { thresholdMiB: cfg.keepAlive?.thresholdMiB ?? 400 },
    files: {
      status: '.goal-loop/session-log-status.json',
      request: '.goal-loop/trim-request.json',
      history: '.goal-loop/trim-history',
      handoff: '.goal-loop/handoff.md',
    },
    continueText: 'Continue. Your session log was just trimmed to its latest compaction after you stopped for a log trim. ' +
      'Check .goal-loop/STOP, then resume from the latest addendum in {handoff}.',
  };
}

/** copilot-forever's agent snippet with the goal-loop paths, for the Orchestrator. */
export function safePointSnippet() {
  return fs.readFileSync(path.join(KIT_ROOT, 'agent', 'snippet.md'), 'utf8')
    .replace(/^<!--[\s\S]*?-->\s*/, '')
    .replaceAll('{{status}}', '.goal-loop/session-log-status.json')
    .replaceAll('{{request}}', '.goal-loop/trim-request.json')
    .replaceAll('{{handoff}}', '.goal-loop/handoff.md')
    .trim();
}

export const GITIGNORE = `# goal-loop: machine-local loop state (not part of the project)
handoff.md
PLAN.md
prompts/
receipts/
STOP
session-log-status.json
trim-request.json
trim-history/
PLAN.approved.json
ralph/
`;

/**
 * Everything bootstrap writes into the target repo.
 * @returns {Array<{ rel: string, content: string, alt?: string, note?: string, keep?: boolean, ownMarker?: string }>}
 */
export function plannedFiles(cfg, repo) {
  const vars = { ...cfg, labels: cfg.github.labels, safePointSnippet: safePointSnippet() };
  const t = (p) => fs.readFileSync(path.join(TEMPLATES, p), 'utf8');
  return [
    { rel: '.github/agents/orchestrator.agent.md', content: render(t('agents/orchestrator.agent.md'), vars) },
    { rel: '.github/agents/architect.agent.md', content: render(t('agents/architect.agent.md'), vars) },
    { rel: '.github/agents/builder.agent.md', content: render(t('agents/builder.agent.md'), vars) },
    { rel: '.github/agents/diff-reviewer.agent.md', content: render(t('agents/diff-reviewer.agent.md'), vars) },
    // An existing copilot-instructions.md is the project's own: never overwritten without --force.
    { rel: '.github/copilot-instructions.md', content: t('copilot-instructions.md'), alt: '.goal-loop/copilot-instructions.goal-loop.md',
      note: 'merge it into your existing .github/copilot-instructions.md', ownMarker: '# Standing orders' },
    { rel: '.goal-loop/config.json', content: JSON.stringify(cfg, null, 2) + '\n' },
    { rel: '.goal-loop/gate.mjs', content: t('gate.mjs') },
    { rel: '.goal-loop/handoff.md', content: t('handoff.md') },
    { rel: '.goal-loop/GOAL.md', content: t('GOAL.md'), keep: true },
    { rel: '.goal-loop/.gitignore', content: GITIGNORE },
    { rel: '.goal-loop/copilot-forever.config.json', content: JSON.stringify(keepAliveConfig(cfg, repo), null, 2) + '\n' },
  ];
}

/**
 * Write the planned files. Existing files are skipped unless force (GOAL.md is never overwritten;
 * an existing copilot-instructions.md gets the goal-loop version written beside it instead).
 */
export function writeFiles(repo, files, log, { dryRun = false, force = false } = {}) {
  const results = [];
  for (const f of files) {
    let rel = f.rel;
    const target = path.join(repo, rel);
    let action = 'create';
    if (exists(target)) {
      const current = fs.readFileSync(target, 'utf8');
      const ours = !f.ownMarker || current.startsWith(f.ownMarker);
      if (f.keep) action = 'keep';
      else if (current === f.content) action = 'unchanged';
      else if (f.alt && !ours) {
        rel = f.alt;
        action = exists(path.join(repo, rel)) && !force ? 'skip' : 'create';
      } else action = force ? 'overwrite' : 'skip';
    }
    const abs = path.join(repo, rel);
    if ((action === 'create' || action === 'overwrite') && !dryRun) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content);
    }
    const verb = dryRun && (action === 'create' || action === 'overwrite') ? `would ${action}` : action;
    log.info(`${verb.padEnd(15)} ${rel}${rel !== f.rel ? ` (${f.rel} exists: ${f.note})` : ''}${action === 'skip' ? ' (exists; --force to overwrite)' : ''}`);
    results.push({ rel, action });
  }
  return results;
}

/** Tools the loop needs; a missing required one is reported, not fatal. */
export async function checkPrerequisites(log) {
  const checks = [
    { name: 'node', cmd: process.execPath, args: ['--version'], required: true },
    { name: 'git', cmd: 'git', args: ['--version'], required: true },
    { name: 'gh (GitHub CLI)', cmd: 'gh', args: ['--version'], required: true },
    { name: 'gh logged in', cmd: 'gh', args: ['auth', 'status'], required: true },
    { name: 'code (VS Code CLI)', cmd: 'code', args: ['--version'], required: true },
    { name: 'copilot (Copilot CLI)', cmd: 'copilot', args: ['--version'], required: false },
  ];
  const missing = [];
  for (const c of checks) {
    const r = await run(c.cmd, c.args, { timeoutMs: 30000 });
    const ok = r.code === 0;
    const line = (r.stdout || r.stderr).split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
    log.info(`${ok ? 'ok  ' : c.required ? 'MISS' : 'opt '} ${c.name}${ok ? `: ${line.slice(0, 60)}` : ''}`);
    if (!ok && c.required) missing.push(c.name);
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) missing.push(`node 22+ (this is ${process.versions.node})`);
  return missing;
}

export function nextSteps(repo, cfg, { linked, started = false }) {
  const cf = linked ? 'copilot-forever' : `node "${path.join(KIT_ROOT, 'bin', 'copilot-forever.mjs')}"`;
  const conf = '--config .goal-loop/copilot-forever.config.json';
  const port = cfg.keepAlive?.port ?? 47801;
  const keepAlive = started
    ? '    (done by --start: the watcher is scheduled and the standalone host is running)'
    : `      ${cf} doctor ${conf}\n      ${cf} install ${conf}\n      ${cf} host start ${conf}`;
  return `
Next steps (in ${repo}):

 1. Write your goal in .goal-loop/GOAL.md (or paste it into the chat in step 6; the Orchestrator saves it there).
 2. Check .goal-loop/config.json: the models (the reviewer must be another model family than the
    builder), gate.command (your full test command) and the caps. After changing models, run the
    bootstrap again with --force to re-render the agents.
 3. Commit the scaffolding yourself (stage the files by name):
      git add .github/agents .github/copilot-instructions.md .goal-loop
      git commit -m "Add goal-loop agents"
 4. Make sure the repo has a GitHub remote and you are logged in: gh auth status

 Then pick a mode.

 Persistent session (one live session in VS Code, kept alive by copilot-forever):
 5. Keep the session alive across VS Code restarts:
${keepAlive}
    In VS Code, add the standalone host to the chat.remoteAgentHosts user setting:
    address localhost:${port}, token from ~/.copilot-forever/token.txt.
 6. In the Agents window: new session on that host, folder ${repo}, agent "Orchestrator".
    Send: start
 7. Read the plan it shows you. Reply APPROVE PLAN to let it file the issues and start building.

 Ralph loop (a fresh copilot -p Orchestrator run per step; no host, no trims):
 5. ${cf} loop --mode ralph --repo "${repo}" --dry-run      (see what the first run would do)
 6. ${cf} loop --mode ralph --repo "${repo}"                (the first run writes .goal-loop/PLAN.md and stops)
 7. Read .goal-loop/PLAN.md, then: ${cf} loop approve-plan --repo "${repo}"
    and run the loop again. It runs with --allow-all-tools: use a sandbox (see the README).

 Either mode: create .goal-loop/STOP to stop at the next step.
`;
}

/**
 * The whole bootstrap.
 * @param {{ repo: string, config?: string, dryRun?: boolean, force?: boolean, install?: boolean, link?: boolean, allowSameFamily?: boolean, print?: boolean, start?: boolean, log: any }} o
 */
export async function bootstrap(o) {
  const { log, dryRun = false } = o;
  const repo = path.resolve(o.repo);
  if (!exists(repo)) throw new Refusal(`${repo} does not exist; create and clone the target repository first`, 2);
  const top = await run('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { timeoutMs: 30000 });
  if (top.code !== 0) throw new Refusal(`${repo} is not a git repository (git init it, or clone it from GitHub)`, 2);

  let raw = {};
  if (o.config) {
    try { raw = JSON.parse(fs.readFileSync(path.resolve(o.config), 'utf8')); } catch (e) { throw new Refusal(`cannot read ${o.config}: ${e.message}`, 2); }
  } else if (exists(path.join(repo, '.goal-loop', 'config.json'))) {
    raw = JSON.parse(fs.readFileSync(path.join(repo, '.goal-loop', 'config.json'), 'utf8'));
    log.info('using the existing .goal-loop/config.json');
  }
  const cfg = resolveGoalLoopConfig(raw, { allowSameFamily: o.allowSameFamily });

  log.info('prerequisites:');
  const missing = await checkPrerequisites(log);

  let linked = false;
  if (o.install !== false) {
    if (!exists(path.join(KIT_ROOT, 'node_modules', '@microsoft', 'agent-host-protocol'))) {
      log.info(`${dryRun ? 'would run' : 'run'}: npm ci (in ${KIT_ROOT})`);
      if (!dryRun) {
        const r = await run('npm', ['ci', '--no-fund', '--no-audit'], { cwd: KIT_ROOT, timeoutMs: 600000 });
        if (r.code !== 0) throw new Error(`npm ci failed: ${(r.stderr || r.stdout).trim().slice(-500)}`);
      }
    }
    if (o.link !== false) {
      log.info(`${dryRun ? 'would run' : 'run'}: npm link (puts copilot-forever on PATH)`);
      if (!dryRun) {
        const r = await run('npm', ['link', '--no-fund', '--no-audit'], { cwd: KIT_ROOT, timeoutMs: 300000 });
        linked = r.code === 0;
        if (!linked) log.warn(`npm link failed; use node bin/copilot-forever.mjs instead (${(r.stderr || r.stdout).trim().slice(-200)})`);
      } else linked = true;
    }
  }

  log.info(`files in ${repo}:`);
  const results = writeFiles(repo, plannedFiles(cfg, repo), log, { dryRun, force: o.force });
  if (missing.length) log.warn(`missing before the first run: ${missing.join(', ')}`);
  if (o.start) {
    // Persistent mode: schedule the watcher and start the standalone host for this repo now.
    const { loadConfig, resolveConfig } = await import('./config.mjs');
    const kaFile = path.join(repo, '.goal-loop', 'copilot-forever.config.json');
    const ka = exists(kaFile) ? loadConfig(kaFile) : resolveConfig(keepAliveConfig(cfg, repo), path.dirname(kaFile), kaFile);
    const { install } = await import('./install.mjs');
    const { startHost } = await import('./host.mjs');
    log.info('starting the keep-alive layer (--start):');
    await install(ka, log, { dryRun });
    await startHost(ka, log, { dryRun, viaService: false });
  }
  const steps = nextSteps(repo, cfg, { linked, started: !!o.start });
  if (o.print !== false) process.stdout.write(steps);
  return { cfg, results, missing, steps };
}
