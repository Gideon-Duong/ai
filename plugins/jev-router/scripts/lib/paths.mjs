import os from 'node:os';
import path from 'node:path';

/**
 * Well-known filesystem locations used by the router.
 */
export class Paths {
  /** User-level Claude Code directory (`~/.claude`). */
  static CLAUDE_DIR = path.join(os.homedir(), '.claude');

  /** Router data directory holding `config.json` and `log.jsonl`. */
  static DATA_DIR = path.join(Paths.CLAUDE_DIR, 'jev-router');

  /** User settings file, read for `enabledPlugins`. */
  static SETTINGS_FILE = path.join(Paths.CLAUDE_DIR, 'settings.json');

  /** Registry of installed plugins and their install paths. */
  static INSTALLED_PLUGINS_FILE = path.join(Paths.CLAUDE_DIR, 'plugins', 'installed_plugins.json');
}
