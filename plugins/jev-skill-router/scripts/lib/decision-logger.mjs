import fs from 'node:fs';
import path from 'node:path';
import { Paths } from './paths.mjs';

/**
 * Appends one JSON line per routed prompt to `~/.claude/jev-router/log.jsonl`,
 * for reviewing suggestions and tuning thresholds.
 */
export class DecisionLogger {
  /**
   * @param {boolean} enabled When false, every call is a no-op.
   * @param {string} [file] Log file path.
   */
  constructor(enabled, file = path.join(Paths.DATA_DIR, 'log.jsonl')) {
    this.enabled = enabled;
    this.file = file;
  }

  /**
   * Writes a record with a timestamp. Failures are ignored so logging never breaks the hook.
   * @param {Record<string, unknown>} record
   */
  write(record) {
    if (!this.enabled) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
    } catch {
      /** Logging is best-effort. */
    }
  }
}
