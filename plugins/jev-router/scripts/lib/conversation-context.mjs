import fs from 'node:fs';

/**
 * The assistant's last reply before the current prompt, read from the
 * session transcript. Short follow-ups such as "do item 1 and push it" only
 * make sense with it, so it is sent to Jev as context for the prompt.
 */
export class ConversationContext {
  /** Sent once in the state so every question reads the reply the same way. */
  static READING_NOTE = 'previous_assistant_reply is context only: use it to understand what a short or referential prompt ("do item 1", "push it") refers to. Judge only what the user asks now in prompt, not what the reply discussed.';

  /**
   * @param {string} previousReply Text of the last main-thread assistant reply, or `''`.
   */
  constructor(previousReply) {
    this.previousReply = previousReply;
  }

  /**
   * Reads the last assistant text in the main thread (subagent sidechains are skipped).
   * @param {string|undefined} transcriptPath `transcript_path` from the hook input.
   * @param {number} maxChars Keep at most this many characters, from the end of the reply,
   *   where next steps and questions to the user usually are.
   * @returns {ConversationContext}
   */
  static load(transcriptPath, maxChars) {
    if (!transcriptPath || maxChars <= 0) return new ConversationContext('');
    let lines;
    try {
      lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
    } catch {
      return new ConversationContext('');
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const text = ConversationContext.#assistantText(lines[i]);
      if (text) return new ConversationContext(text.length > maxChars ? `…${text.slice(-maxChars)}` : text);
    }
    return new ConversationContext('');
  }

  /**
   * Builds the Jev state: the prompt plus, when known, the previous reply.
   * @param {string} prompt Current user prompt.
   * @returns {{prompt: string, previous_assistant_reply?: string, how_to_read?: string}}
   */
  toState(prompt) {
    if (!this.previousReply) return { prompt };
    return { prompt, previous_assistant_reply: this.previousReply, how_to_read: ConversationContext.READING_NOTE };
  }

  /**
   * @param {string} line One transcript JSONL line.
   * @returns {string} Joined text blocks of a main-thread assistant message, or `''`.
   */
  static #assistantText(line) {
    if (!line.includes('"type":"assistant"')) return '';
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return '';
    }
    if (row.type !== 'assistant' || row.isSidechain) return '';
    const content = Array.isArray(row.message?.content) ? row.message.content : [];
    return content.filter(c => c.type === 'text' && c.text).map(c => c.text).join('\n').trim();
  }
}
