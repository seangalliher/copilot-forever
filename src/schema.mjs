// Parses a Copilot session events.jsonl and checks that its layout is one this kit knows.
// The file is an internal, undocumented format; anything unexpected makes the trim refuse.
import fs from 'node:fs';

/**
 * Parse events.jsonl text. A partial last line (a write in progress) is dropped; any other
 * unparsable line is an error.
 * @returns {{ events: any[], droppedPartialLast: boolean }}
 */
export function parseEvents(text) {
  const lines = text.split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let droppedPartialLast = false;
  if (lines.length) {
    try {
      JSON.parse(lines[lines.length - 1]);
    } catch {
      lines.pop();
      droppedPartialLast = true;
    }
  }
  const events = lines.map((l, i) => {
    try {
      return JSON.parse(l);
    } catch (e) {
      throw new SchemaError(`line ${i + 1} is not JSON (${e.message})`);
    }
  });
  return { events, droppedPartialLast };
}

export function readEvents(file) {
  return parseEvents(fs.readFileSync(file, 'utf8'));
}

export class SchemaError extends Error {
  constructor(m) { super(m); this.name = 'SchemaError'; }
}

/**
 * Check the layout. Returns a list of problems; empty means the trim may proceed.
 * @param {any[]} events
 * @param {{ sessionId?: string, knownVersions?: number[] }} opts
 */
export function checkSchema(events, { sessionId, knownVersions = [1] } = {}) {
  const p = [];
  if (!events.length) return ['the log is empty'];
  const first = events[0];
  if (first?.type !== 'session.start') p.push(`the first event is ${JSON.stringify(first?.type)}, not session.start`);
  else {
    const d = first.data ?? {};
    if (!knownVersions.includes(d.version)) p.push(`unknown log version ${JSON.stringify(d.version)} (known: ${knownVersions.join(', ')})`);
    if (d.producer !== undefined && d.producer !== 'copilot-agent') p.push(`unknown producer ${JSON.stringify(d.producer)}`);
    if (sessionId && d.sessionId !== sessionId) p.push(`session.start names session ${JSON.stringify(d.sessionId)}, not ${sessionId}`);
  }
  const ids = new Set();
  for (let i = 0; i < events.length && p.length < 10; i++) {
    const e = events[i];
    const where = `event ${i + 1}`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) { p.push(`${where} is not an object`); continue; }
    if (typeof e.type !== 'string' || !e.type) p.push(`${where} has no type`);
    if (typeof e.id !== 'string' || !e.id) p.push(`${where} has no string id`);
    else if (ids.has(e.id)) p.push(`${where} repeats id ${e.id}`);
    else ids.add(e.id);
    if (!(e.parentId === null || typeof e.parentId === 'string')) p.push(`${where} has a parentId that is neither a string nor null`);
    if (e.data !== undefined && (typeof e.data !== 'object' || e.data === null)) p.push(`${where} has a non-object data`);
    if (e.type === 'session.compaction_complete' && typeof e.data?.success !== 'boolean') {
      p.push(`${where}: session.compaction_complete without a boolean data.success`);
    }
  }
  return p;
}
