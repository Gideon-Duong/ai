/**
 * A situational built-in tool worth suggesting (not everyday tools such as Read or Bash).
 */
export class ToolEntry {
  /**
   * @param {string} name Tool name as the assistant calls it, e.g. `WebSearch`.
   * @param {string} description What the tool is for.
   * @param {boolean} [deferred] Whether its schema must be loaded with ToolSearch first.
   */
  constructor(name, description, deferred = false) {
    this.kind = 'tool';
    this.name = name;
    this.description = description;
    this.deferred = deferred;
  }
}

/**
 * An MCP server, judged as a whole: its tools share one question, since a
 * session can expose hundreds of MCP tools.
 */
export class McpServerEntry {
  /** Prefix of every MCP tool name. */
  static PREFIX = 'mcp__';

  /** Tools exposed by a connector that is not signed in yet. */
  static AUTH_ONLY_TOOLS = ['authenticate', 'complete_authentication'];

  /**
   * @param {string} name Server name, e.g. `claude_ai_Notion`.
   * @param {string[]} tools Tool names without the `mcp__<server>__` prefix.
   */
  constructor(name, tools) {
    this.kind = 'mcp';
    this.name = name;
    this.tools = tools;
  }

  /** @returns {string} Server description built from its tool names. */
  get description() {
    return `MCP server "${this.name}" providing tools: ${this.tools.join(', ')}`;
  }

  /** @returns {string} Prefix shared by the server's full tool names. */
  get toolPrefix() {
    return `${McpServerEntry.PREFIX}${this.name}__`;
  }

  /**
   * Groups full MCP tool names (`mcp__<server>__<tool>`) by server.
   * @param {string[]} toolNames Any tool names; non-MCP names are ignored.
   * @param {string[]} [failed] Servers that failed to connect, excluded.
   *   Servers exposing only sign-in tools are excluded too.
   * @returns {McpServerEntry[]}
   */
  static group(toolNames, failed = []) {
    /** @type {Map<string, string[]>} */
    const servers = new Map();
    for (const full of toolNames) {
      if (!full.startsWith(McpServerEntry.PREFIX)) continue;
      const rest = full.slice(McpServerEntry.PREFIX.length);
      const sep = rest.indexOf('__');
      if (sep <= 0) continue;
      const server = rest.slice(0, sep);
      if (failed.includes(server)) continue;
      if (!servers.has(server)) servers.set(server, []);
      servers.get(server).push(rest.slice(sep + 2));
    }
    return [...servers]
      .filter(([, tools]) => !tools.every(t => McpServerEntry.AUTH_ONLY_TOOLS.includes(t)))
      .map(([name, tools]) => new McpServerEntry(name, tools));
  }
}

/**
 * Descriptions of situational built-in tools. Only tools listed here are
 * suggested, so everyday tools never add noise to the plan.
 */
export const BUILT_IN_TOOLS = Object.freeze({
  WebSearch: 'Search the web for current information, docs, or answers beyond the codebase.',
  WebFetch: 'Fetch and read a specific URL, such as a documentation page or API reference.',
  LSP: 'Language-server code intelligence: go to definition, find references, hover types, diagnostics.',
  NotebookEdit: 'Edit cells of a Jupyter notebook (.ipynb).',
  Monitor: 'Watch a background process or log and react when a condition is met, instead of polling.',
  CronCreate: 'Schedule a recurring or delayed task in this session.',
  ScheduleWakeup: 'Resume work later at a chosen delay, for self-paced loops.',
  EnterWorktree: 'Work in an isolated git worktree so changes do not touch the current checkout.',
  EnterPlanMode: 'Switch to plan mode to design an approach and get approval before editing.',
  AskUserQuestion: 'Ask the user a multiple-choice question when a decision is genuinely theirs.',
  PushNotification: 'Send the user a notification when long-running work finishes.',
  Artifact: 'Publish an HTML page (report, dashboard, app) the user can open and share.',
});

/**
 * Builds entries for the situational built-in tools.
 * @param {string[]} deferred Deferred tool names in the session; matching
 *   entries are flagged so the plan says to load them with ToolSearch.
 * @returns {ToolEntry[]}
 */
export function builtInTools(deferred) {
  return Object.entries(BUILT_IN_TOOLS)
    .map(([name, description]) => new ToolEntry(name, description, deferred.includes(name)));
}
