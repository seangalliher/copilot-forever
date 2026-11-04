// Logger: one line per message to stdout and to a size-capped log file, with secrets redacted.
import fs from 'node:fs';
import path from 'node:path';

const MAX_LOG_BYTES = 5 * 1048576;
const secrets = new Set();

/** Register a value that must never appear in any log line or console output. */
export function addSecret(value) {
  if (typeof value === 'string' && value.length >= 8) secrets.add(value);
}

/** Remove registered secrets and connection-token URL parameters from text. */
export function redact(text) {
  let s = String(text);
  for (const v of secrets) s = s.split(v).join('<redacted>');
  s = s.replace(/([?&](?:tkn|token|connection-token|connectionToken)=)[^&\s"']+/gi, '$1<redacted>');
  s = s.replace(/(--connection-token[ =])(?!-)\S+/g, '$1<redacted>');
  return s;
}

export class Logger {
  /**
   * @param {{ file?: string, dryRun?: boolean, quiet?: boolean, prefix?: string }} opts
   */
  constructor({ file, dryRun = false, quiet = false, prefix = '' } = {}) {
    this.file = file;
    this.dryRun = dryRun;
    this.quiet = quiet;
    this.prefix = prefix;
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, file + '.1');
      } catch { /* no log yet */ }
    }
  }

  line(level, msg) {
    const tag = level === 'info' ? '' : `${level.toUpperCase()}: `;
    return redact(`${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')} ${this.prefix}${this.dryRun ? '[dry-run] ' : ''}${tag}${msg}`);
  }

  write(level, msg) {
    const l = this.line(level, msg);
    if (this.file) {
      try { fs.appendFileSync(this.file, l + '\n'); } catch { /* the console line still goes out */ }
    }
    if (!this.quiet) (level === 'error' || level === 'warn' ? console.error : console.log)(l);
  }

  info(m) { this.write('info', m); }
  warn(m) { this.write('warn', m); }
  error(m) { this.write('error', m); }
}

/** A logger that only collects lines (tests, nested calls). */
export class MemoryLogger extends Logger {
  constructor(opts = {}) {
    super({ ...opts, quiet: true });
    this.lines = [];
  }
  write(level, msg) { this.lines.push(this.line(level, msg)); }
}
