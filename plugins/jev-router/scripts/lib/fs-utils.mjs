import fs from 'node:fs';
import path from 'node:path';

/**
 * Error-tolerant filesystem helpers. Every method returns an empty
 * value instead of throwing, so a missing or unreadable file never
 * breaks the hook.
 */
export class FsUtils {
  /**
   * Reads and parses a JSON file.
   * @param {string} file Absolute path to the file.
   * @returns {any|null} Parsed value, or `null` when missing or invalid.
   */
  static readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Lists the immediate subdirectories of a directory.
   * @param {string} dir Directory to scan.
   * @returns {string[]} Absolute paths of subdirectories.
   */
  static listDirs(dir) {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(dir, entry.name));
    } catch {
      return [];
    }
  }

  /**
   * Lists files in a directory with the given extension.
   * @param {string} dir Directory to scan.
   * @param {string} ext Extension including the dot, e.g. `.md`.
   * @returns {string[]} Absolute paths of matching files.
   */
  static listFiles(dir, ext) {
    try {
      return fs.readdirSync(dir)
        .filter(name => name.endsWith(ext))
        .map(name => path.join(dir, name));
    } catch {
      return [];
    }
  }

  /**
   * Reads top-level fields from a Markdown file's YAML frontmatter.
   * Supports `key: value` scalars and `key:` followed by `- item` lists,
   * which covers the fields skills and agents use. Nested maps are skipped.
   * @param {string} file Markdown file with a `---` frontmatter block.
   * @returns {Record<string, string|string[]>|null} Fields, or `null` when
   *   there is no frontmatter or `name`/`description` is missing.
   */
  static readFrontmatter(file) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    const lines = text.split(/\r?\n/);
    if (lines[0] !== '---') return null;
    const end = lines.indexOf('---', 1);
    if (end < 0) return null;

    /** @type {Record<string, string|string[]>} */
    const fields = {};
    let listKey = null;
    for (const line of lines.slice(1, end)) {
      const item = line.trimStart();
      if (listKey && item.startsWith('- ')) {
        fields[listKey].push(FsUtils.#unquote(item.slice(2).trim()));
        continue;
      }
      listKey = null;
      const colon = line.indexOf(':');
      const key = line.slice(0, colon);
      if (colon <= 0 || !/^[A-Za-z_-]+$/.test(key)) continue;
      const value = FsUtils.#unquote(line.slice(colon + 1).trim());
      if (value) {
        fields[key] = value;
      } else {
        fields[key] = [];
        listKey = key;
      }
    }
    return typeof fields.name === 'string' && typeof fields.description === 'string' ? fields : null;
  }

  /**
   * Normalizes a list-valued field: YAML list, comma-separated string, or absent.
   * @param {string|string[]|undefined} value
   * @returns {string[]|null} Trimmed items, or `null` when the field is absent.
   */
  static toList(value) {
    if (value === undefined) return null;
    const items = Array.isArray(value) ? value : value.replace(/^\[|\]$/g, '').split(',');
    return items.map(v => FsUtils.#unquote(v.trim())).filter(Boolean);
  }

  /**
   * Removes one pair of matching surrounding quotes, if present.
   * @param {string} value Trimmed frontmatter value.
   * @returns {string}
   */
  static #unquote(value) {
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
    return quoted ? value.slice(1, -1).trim() : value;
  }
}
