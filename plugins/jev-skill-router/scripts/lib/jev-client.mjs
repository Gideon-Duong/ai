/**
 * @typedef {{type: 'noul', instructions: string}} NoulQuestion
 * @typedef {{type: 'choice', instructions: string, criteria: Record<string, string|null>}} ChoiceQuestion
 * @typedef {{type: 'noul', noul: number}} NoulAnswer
 * @typedef {{type: 'choice', choice: string, probabilities: Record<string, number>, confidence: number}} ChoiceAnswer
 * @typedef {Record<string, NoulQuestion|ChoiceQuestion>} Questions
 * @typedef {Record<string, NoulAnswer|ChoiceAnswer>} Answers
 */

/**
 * Minimal HTTP client for TypeSafe's System One endpoint (`POST /v1/systemone`).
 * Uses the built-in `fetch`, so the plugin needs no npm dependencies.
 */
export class JevClient {
  /**
   * @param {object} options
   * @param {string} options.apiKey TypeSafe API key.
   * @param {string} [options.baseUrl] API base URL.
   * @param {string} options.model Jev model alias or versioned ID.
   * @param {number} options.timeoutMs Request timeout in milliseconds.
   */
  constructor({ apiKey, baseUrl = 'https://api.typesafe.ai', model, timeoutMs }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Creates the client for the environment: a {@link MockJevClient} when
   * `JEV_ROUTER_MOCK=1`, otherwise a real client. The key comes from the
   * plugin's `typesafe_api_key` option (prompted when the plugin is enabled,
   * exported as `CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY`), falling back to
   * `TYPESAFE_API_KEY` for local runs.
   * @param {import('./config.mjs').Config} config
   * @returns {JevClient}
   * @throws {Error} When no API key is set and mock mode is off.
   */
  static fromEnv(config) {
    if (process.env.JEV_ROUTER_MOCK === '1') return new MockJevClient();
    const apiKey = process.env.CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY || process.env.TYPESAFE_API_KEY;
    if (!apiKey) throw new Error('TypeSafe API key not set: configure the plugin option or TYPESAFE_API_KEY');
    return new JevClient({
      apiKey,
      baseUrl: process.env.TYPESAFE_BASE_URL,
      model: config.model,
      timeoutMs: config.timeoutMs,
    });
  }

  /**
   * Evaluates all questions against one state in a single batched request.
   * @param {object} state Content the questions refer to, e.g. `{ prompt }`.
   * @param {Questions} questions Questions keyed by caller-chosen IDs.
   * @returns {Promise<Answers>} Answers under the same IDs.
   * @throws {Error} On HTTP errors or timeout.
   */
  async ask(state, questions) {
    const res = await fetch(`${this.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, state, questions }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()).answers;
  }
}

/**
 * Offline stand-in for {@link JevClient}. Scores by word overlap between the
 * prompt and each question's description; only useful for testing plumbing.
 */
export class MockJevClient extends JevClient {
  constructor() {
    super({ apiKey: '', model: 'mock', timeoutMs: 0 });
  }

  /** @inheritdoc */
  async ask(state, questions) {
    const words = new Set(MockJevClient.#words(state.prompt));
    const answers = {};
    for (const [id, question] of Object.entries(questions)) {
      answers[id] = question.type === 'choice'
        ? MockJevClient.#choose(question, words)
        : { type: 'noul', noul: MockJevClient.#noul(id, question, words, state.prompt) };
    }
    return answers;
  }

  /**
   * Noul stand-in: overlap between prompt words and the question's description.
   * @param {string} id Question ID.
   * @param {NoulQuestion} question
   * @param {Set<string>} words Prompt words.
   * @param {string} prompt Raw prompt.
   * @returns {number}
   */
  static #noul(id, question, words, prompt) {
    if (id === 'needs_plan') return Math.min(1, words.size / 25);
    if (id === 'parallel') return /\b(and|also|plus|both)\b/i.test(prompt) ? 0.8 : 0.2;
    const description = question.instructions.split('\n').slice(0, 2).join(' ');
    const hits = new Set(MockJevClient.#words(description).filter(w => words.has(w))).size;
    return Math.min(1, hits / 3);
  }

  /**
   * Choice stand-in: the option whose description overlaps the prompt most;
   * the first option (main agent) wins ties.
   * @param {ChoiceQuestion} question
   * @param {Set<string>} words Prompt words.
   * @returns {ChoiceAnswer}
   */
  static #choose(question, words) {
    const scores = Object.entries(question.criteria).map(([option, desc]) => [
      option,
      1 + new Set(MockJevClient.#words(desc ?? '').filter(w => words.has(w))).size,
    ]);
    const total = scores.reduce((sum, [, n]) => sum + n, 0);
    const probabilities = Object.fromEntries(scores.map(([option, n]) => [option, n / total]));
    const [choice, best] = scores.reduce((a, b) => (b[1] > a[1] ? b : a));
    return { type: 'choice', choice, probabilities, confidence: best / total };
  }

  /**
   * @param {string} text
   * @returns {string[]} Lowercased words of four or more letters/digits.
   */
  static #words(text) {
    return text.toLowerCase().match(/[\p{L}\d]{4,}/gu) ?? [];
  }
}
