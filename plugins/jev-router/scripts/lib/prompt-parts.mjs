/**
 * Splits a prompt into what the user typed and what they pasted.
 *
 * Claude Code wraps pasted text in `<pasted_content id="…">…</pasted_content id="…">`.
 * Pasted logs, output, and data are reference material: text inside them that
 * looks like a task must not be judged as the user's request.
 */
export class PromptParts {
  /** Opening tag prefix. */
  static OPEN = '<pasted_content';

  /** Closing tag prefix. */
  static CLOSE = '</pasted_content';

  /**
   * @param {string} typed Text the user typed, with pasted blocks removed.
   * @param {string[]} pasted Contents of each pasted block.
   */
  constructor(typed, pasted) {
    this.typed = typed;
    this.pasted = pasted;
  }

  /** @returns {boolean} True when the prompt contained pasted blocks. */
  get hasPaste() {
    return this.pasted.length > 0;
  }

  /**
   * Parses a prompt. Scans with `indexOf` rather than a regex so malformed or
   * huge pastes cannot cause backtracking.
   * @param {string} prompt Raw prompt from the hook input.
   * @returns {PromptParts}
   */
  static parse(prompt) {
    const typed = [];
    const pasted = [];
    let pos = 0;
    while (pos < prompt.length) {
      const open = prompt.indexOf(PromptParts.OPEN, pos);
      if (open < 0) break;
      const openEnd = prompt.indexOf('>', open);
      const close = openEnd < 0 ? -1 : prompt.indexOf(PromptParts.CLOSE, openEnd);
      const closeEnd = close < 0 ? -1 : prompt.indexOf('>', close);
      if (closeEnd < 0) break;
      typed.push(prompt.slice(pos, open));
      pasted.push(prompt.slice(openEnd + 1, close).trim());
      pos = closeEnd + 1;
    }
    typed.push(prompt.slice(pos));
    return new PromptParts(typed.join(' ').replaceAll(/\s+/g, ' ').trim(), pasted);
  }

  /**
   * Returns the pasted blocks joined and truncated, for use as Jev state.
   * @param {number} maxChars Maximum characters kept.
   * @returns {string}
   */
  pastedExcerpt(maxChars) {
    const joined = this.pasted.join('\n---\n');
    return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined;
  }
}
