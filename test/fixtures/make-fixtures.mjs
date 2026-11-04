// Regenerates the synthetic events.jsonl fixtures: node test/fixtures/make-fixtures.mjs
// Each fixture is a tiny log with the same layout as a real Copilot session log (session.start
// version 1, id/parentId chain, compaction events), with made-up content.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_SESSION_ID = '00000000-0000-4000-8000-000000000001';

function builder(sessionId = FIXTURE_SESSION_ID, version = 1) {
  const events = [];
  let n = 0;
  let t = Date.parse('2026-11-01T00:00:00Z');
  const add = (type, data = {}, extra = {}) => {
    const id = `e${String(++n).padStart(3, '0')}`;
    const parentId = 'parentId' in extra ? extra.parentId : (events.length ? events[events.length - 1].id : null);
    const { parentId: _p, ...rest } = extra;
    events.push({ type, data, id, timestamp: new Date((t += 1000)).toISOString(), parentId, ...rest });
    return id;
  };
  add('session.start', { sessionId, version, producer: 'copilot-agent', copilotVersion: '1.0.100', startTime: '2026-11-01T00:00:00Z', selectedModel: 'model-a', context: { cwd: '/repo' } });
  add('session.permissions_changed', { allowAllPermissions: true });
  add('subagent.selected', { agentName: 'orchestrator', agentDisplayName: 'Orchestrator', tools: [] });
  const turn = (text) => {
    add('user.message', { content: text });
    add('assistant.turn_start', { turnId: `t${n}` });
    add('assistant.message', { content: `reply to ${text}` });
    add('assistant.turn_end', { turnId: `t${n}` });
  };
  const compaction = (success) => {
    const s = add('session.compaction_start', { trigger: 'threshold', currentTokens: 1000, tokenLimit: 800 });
    add('session.truncation', { tokenLimit: 800 });
    add('session.compaction_complete', success ? { success: true, summaryContent: 'summary of earlier work', checkpointNumber: 1 } : { success: false, error: 'compaction failed' });
    return s;
  };
  return { events, add, turn, compaction };
}

const write = (name, events, tail = '') => {
  fs.writeFileSync(path.join(here, name), events.map((e) => JSON.stringify(e)).join('\n') + '\n' + tail);
};

export function makeAll() {
  { // basic: two turns, one successful compaction, then work whose first event points before the cut
    const b = builder();
    b.turn('one'); b.turn('two');
    b.compaction(true);
    b.add('user.message', { content: 'three' }, { parentId: 'e005' }); // parent before the cut
    b.add('assistant.turn_start', { turnId: 'tx' });
    b.add('assistant.turn_end', { turnId: 'tx' });
    write('basic.jsonl', b.events);
  }
  { // failed-latest: a successful compaction, more work, then a failed compaction (copilot-cli #4663)
    const b = builder();
    b.turn('one');
    b.compaction(true);
    b.turn('two');
    b.compaction(false);
    b.turn('three');
    write('failed-latest.jsonl', b.events);
  }
  { // failed-only: the only compaction failed
    const b = builder();
    b.turn('one');
    b.compaction(false);
    b.turn('two');
    write('failed-only.jsonl', b.events);
  }
  { // in-progress: an old successful compaction, then one that started but has not completed
    const b = builder();
    b.turn('one');
    b.compaction(true);
    b.turn('two');
    b.add('session.compaction_start', { trigger: 'threshold' });
    b.turn('three');
    write('in-progress.jsonl', b.events);
  }
  { // no-compaction
    const b = builder();
    b.turn('one'); b.turn('two');
    write('no-compaction.jsonl', b.events);
  }
  { // unknown-version: a header schema version this kit does not know
    const b = builder(FIXTURE_SESSION_ID, 2);
    b.turn('one');
    b.compaction(true);
    b.turn('two');
    write('unknown-version.jsonl', b.events);
  }
  { // partial-last: a write in progress left half a line
    const b = builder();
    b.turn('one');
    b.compaction(true);
    b.turn('two');
    write('partial-last.jsonl', b.events, '{"type":"assistant.turn_start","data":{"tur');
  }
  { // null-parent: root events with parentId null (as model.turn_started is in 1.0.10x) stay roots;
    // a subagent's own subagent.selected near the top is not a header event
    const b = builder();
    b.add('subagent.selected', { agentName: 'helper' }, { agentId: 'sub-1' });
    b.turn('one');
    b.compaction(true);
    b.add('model.turn_started', { kind: 'x', turn: 1 }, { parentId: null });
    b.turn('two');
    write('null-parent.jsonl', b.events);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) makeAll();
