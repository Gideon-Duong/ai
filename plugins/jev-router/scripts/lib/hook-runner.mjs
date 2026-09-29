import { CatalogScanner } from './catalog.mjs';
import { Config } from './config.mjs';
import { ConversationContext } from './conversation-context.mjs';
import { DecisionLogger } from './decision-logger.mjs';
import { JevClient } from './jev-client.mjs';
import { PromptParts } from './prompt-parts.mjs';
import { CapabilityRouter } from './capability-router.mjs';

/**
 * @typedef {object} HookInput
 * @property {string} [prompt] The submitted prompt.
 * @property {string} [cwd] Session working directory.
 * @property {string} [transcript_path] Session transcript, source of the tool/agent/skill listings.
 */

/**
 * Orchestrates one `UserPromptSubmit` invocation: read input, scan the
 * catalog, ask Jev, and emit `additionalContext`. Fail-open: on any error
 * nothing is printed and the prompt proceeds unchanged.
 */
export class HookRunner {
  /** Length of the prompt preview stored in the log. */
  static PROMPT_PREVIEW_CHARS = 200;

  /**
   * @param {object} [options]
   * @param {Config} [options.config] Settings; loaded from disk by default.
   * @param {boolean} [options.testMode] Print a readable result instead of hook JSON.
   */
  constructor({ config = Config.load(), testMode = false } = {}) {
    this.config = config;
    this.testMode = testMode;
    this.logger = new DecisionLogger(config.log);
  }

  /**
   * Builds a runner from process arguments. `--test "<prompt>"` runs
   * against the given prompt in the current directory; set
   * `JEV_ROUTER_TRANSCRIPT` to a transcript path to use its listings.
   * @param {string[]} argv Typically `process.argv`.
   * @returns {{runner: HookRunner, input: HookInput|null}} `input` is null when it must be read from stdin.
   */
  static fromArgv(argv) {
    const testIdx = argv.indexOf('--test');
    if (testIdx < 0) return { runner: new HookRunner(), input: null };
    return {
      runner: new HookRunner({ testMode: true }),
      input: { prompt: argv[testIdx + 1] ?? '', cwd: process.cwd(), transcript_path: process.env.JEV_ROUTER_TRANSCRIPT },
    };
  }

  /**
   * Reads the hook payload Claude Code sends on stdin.
   * @returns {Promise<HookInput>} Parsed payload, or `{}` when empty or not valid JSON.
   */
  static async readStdin() {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    try {
      return data.trim() ? JSON.parse(data) : {};
    } catch {
      return {};
    }
  }

  /**
   * Routes one prompt and writes the result to stdout.
   * @param {HookInput} input
   * @returns {Promise<void>}
   */
  async run(input) {
    const prompt = (input.prompt ?? '').trim();
    if (!this.#shouldRoute(prompt)) return;

    const started = Date.now();
    const preview = prompt.slice(0, HookRunner.PROMPT_PREVIEW_CHARS);
    const parts = PromptParts.parse(prompt);
    if (parts.hasPaste && parts.typed.length < this.config.minPromptChars) {
      this.logger.write({ prompt: preview, ms: Date.now() - started, skipped: 'paste-only' });
      this.#emit('');
      return;
    }

    const catalog = new CatalogScanner(input.cwd, input.transcript_path).scan();
    if (!catalog.skills.length && !catalog.agents.length && !catalog.mcp.length) return;

    try {
      const router = new CapabilityRouter(catalog, this.config);
      const context = ConversationContext.load(input.transcript_path, this.config.contextChars);
      const state = context.toState(parts.typed, parts.pastedExcerpt(this.config.pastedChars));
      const decision = await router.route(JevClient.fromEnv(this.config), state);

      this.logger.write({
        prompt: preview,
        ms: Date.now() - started,
        catalog: {
          skills: catalog.skills.length,
          agents: catalog.agents.length,
          tools: catalog.tools.length,
          mcp: catalog.mcp.length,
        },
        ...decision.toLog(),
      });
      this.#emit(decision.toContext());
    } catch (err) {
      this.logger.write({ prompt: preview, ms: Date.now() - started, error: String(err?.message ?? err) });
      if (this.testMode) console.error(err);
    }
  }

  /**
   * Skips short prompts and slash commands.
   * @param {string} prompt
   * @returns {boolean}
   */
  #shouldRoute(prompt) {
    return prompt.length >= this.config.minPromptChars && !prompt.startsWith('/');
  }

  /**
   * Prints the context as hook JSON, or as plain text in test mode.
   * @param {string} context Rendered suggestions; empty means nothing to inject.
   */
  #emit(context) {
    if (this.testMode) {
      console.log(context || '(no suggestion)');
      return;
    }
    if (!context) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
    }));
  }
}
