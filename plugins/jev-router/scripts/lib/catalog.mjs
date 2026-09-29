import fs from 'node:fs';
import path from 'node:path';
import { FsUtils } from './fs-utils.mjs';
import { Paths } from './paths.mjs';
import { SessionInventory } from './session-inventory.mjs';
import { McpServerEntry, builtInTools } from './tools.mjs';

/**
 * A skill the assistant (or a subagent) can invoke.
 */
export class SkillEntry {
  /**
   * @param {object} fields
   * @param {string} fields.name Invocable name, prefixed with `plugin:` for plugin skills.
   * @param {string} fields.description What the skill is for.
   * @param {string|null} [fields.forkAgent] Subagent type the skill always runs in
   *   (`context: fork`), or `null` when it runs in whoever invokes it.
   */
  constructor({ name, description, forkAgent = null }) {
    this.kind = 'skill';
    this.name = name;
    this.description = description;
    this.forkAgent = forkAgent;
  }

  /**
   * Builds an entry from SKILL.md frontmatter.
   * @param {Record<string, string|string[]>} fm Parsed frontmatter.
   * @param {string} prefix Plugin prefix such as `mattpocock-skills:`, or `''`.
   * @returns {SkillEntry|null} `null` when Claude may not invoke it on its own
   *   (`disable-model-invocation: true`), since suggesting it would be useless.
   */
  static fromFrontmatter(fm, prefix) {
    if (fm['disable-model-invocation'] === 'true') return null;
    const description = [fm.description, fm.when_to_use].filter(Boolean).join(' ');
    const forkAgent = fm.context === 'fork' ? (fm.agent || 'general-purpose') : null;
    return new SkillEntry({ name: prefix + fm.name, description, forkAgent });
  }
}

/**
 * A subagent the assistant can spawn.
 */
export class AgentEntry {
  /** Tool that lets an agent invoke skills. */
  static SKILL_TOOL = 'Skill';

  /**
   * @param {object} fields
   * @param {string} fields.name Agent type, prefixed with `plugin:` for plugin agents.
   * @param {string} fields.description When to delegate to it.
   * @param {string[]|null} [fields.tools] Tool allowlist; `null` means every tool.
   * @param {string[]} [fields.disallowedTools] Tool denylist.
   * @param {string[]} [fields.skills] Skills preloaded at startup (`skills:` field).
   * @param {boolean} [fields.builtIn] Whether it ships with Claude Code.
   */
  constructor({ name, description, tools = null, disallowedTools = [], skills = [], builtIn = false }) {
    this.kind = 'agent';
    this.name = name;
    this.description = description;
    this.tools = tools;
    this.disallowedTools = disallowedTools;
    this.skills = skills;
    this.builtIn = builtIn;
  }

  /**
   * Whether this agent can invoke skills on demand through the `Skill` tool.
   * @returns {boolean}
   */
  get canUseSkills() {
    return this.canUseTool(AgentEntry.SKILL_TOOL);
  }

  /**
   * Whether a tool is available to this agent, honoring allow- and denylists.
   * MCP tools also match server-level entries such as `mcp__notion` or `mcp__notion__*`.
   * @param {string} tool Full tool name, e.g. `WebSearch` or `mcp__claude_ai_Notion__notion-search`.
   * @returns {boolean}
   */
  canUseTool(tool) {
    const matches = pattern => pattern === tool || pattern === '*'
      || (pattern.startsWith(McpServerEntry.PREFIX) && tool.startsWith(pattern.replace(/\*$/, '')));
    if (this.disallowedTools.some(matches)) return false;
    return this.tools === null || this.tools.some(matches);
  }

  /**
   * Whether this agent can use tools of an MCP server.
   * @param {McpServerEntry} server
   * @returns {boolean}
   */
  canUseMcp(server) {
    return server.tools.some(t => this.canUseTool(server.toolPrefix + t));
  }

  /**
   * Builds an entry from an agent Markdown file's frontmatter.
   * @param {Record<string, string|string[]>} fm Parsed frontmatter.
   * @param {string} prefix Plugin prefix, or `''`.
   * @returns {AgentEntry}
   */
  static fromFrontmatter(fm, prefix) {
    return new AgentEntry({
      name: prefix + fm.name,
      description: fm.description,
      tools: FsUtils.toList(fm.tools),
      disallowedTools: FsUtils.toList(fm.disallowedTools) ?? [],
      skills: (FsUtils.toList(fm.skills) ?? []).map(s => (s.includes(':') || !prefix ? s : prefix + s)),
    });
  }
}

/**
 * @typedef {SkillEntry|AgentEntry|import('./tools.mjs').ToolEntry|McpServerEntry} CatalogEntry
 */

/**
 * @typedef {object} Catalog
 * @property {SkillEntry[]} skills Model-invocable skills.
 * @property {AgentEntry[]} agents Subagent types.
 * @property {import('./tools.mjs').ToolEntry[]} tools Situational built-in tools.
 * @property {McpServerEntry[]} mcp Connected MCP servers.
 */

/**
 * Subagents built into Claude Code, used when the session inventory is
 * unavailable. They have no Markdown file to scan, so their capabilities are
 * declared here from the official sub-agents docs.
 */
const BUILT_IN_AGENTS = Object.freeze([
  new AgentEntry({
    name: 'Explore',
    description: 'Fast read-only codebase search: find files, symbols, and usages, and answer where/how questions about the code without modifying it.',
    tools: ['Glob', 'Grep', 'Read', 'WebSearch', 'WebFetch'],
    builtIn: true,
  }),
  new AgentEntry({
    name: 'Plan',
    description: 'Read-only software architect: researches the codebase and designs an implementation plan with critical files and trade-offs.',
    tools: ['Glob', 'Grep', 'Read', 'WebSearch', 'WebFetch'],
    builtIn: true,
  }),
  new AgentEntry({
    name: 'general-purpose',
    description: 'Full-tool agent for multi-step research, code changes, or tasks that need both exploration and modification in an isolated context.',
    builtIn: true,
  }),
  new AgentEntry({
    name: 'claude-code-guide',
    description: 'Answers questions about Claude Code features, hooks, settings, MCP, the Agent SDK, and the Claude API from official docs.',
    tools: ['Bash', 'Read', 'WebFetch', 'WebSearch'],
    builtIn: true,
  }),
]);

/**
 * Discovers what a Claude Code session can use: skills, subagents, situational
 * tools, and MCP servers.
 *
 * The session transcript's listings ({@link SessionInventory}) are the source
 * of truth for names, descriptions, and agent tool access. Files on disk add
 * what listings omit: `context: fork` on skills and `skills:` preloads on
 * agents. Without a transcript, files on disk are used alone.
 */
export class CatalogScanner {
  /** This plugin's own name, excluded from its own catalog. */
  static SELF = 'jev-router';

  /**
   * @param {string} [cwd] Project directory of the session, used for project
   *   entries, project plugin settings, and `local`-scope plugins.
   * @param {string} [transcriptPath] Session transcript, from the hook input.
   */
  constructor(cwd, transcriptPath) {
    this.cwd = cwd;
    this.transcriptPath = transcriptPath;
  }

  /**
   * Builds the deduplicated catalog.
   * @returns {Catalog}
   */
  scan() {
    const roots = [
      { root: Paths.CLAUDE_DIR, prefix: '' },
      ...(this.cwd ? [{ root: path.join(this.cwd, '.claude'), prefix: '' }] : []),
      ...this.#pluginRoots(),
    ];
    const fileSkills = CatalogScanner.#dedupe(roots.flatMap(r => this.#skillsIn(r.root, r.prefix)));
    const fileAgents = CatalogScanner.#dedupe([...BUILT_IN_AGENTS, ...roots.flatMap(r => this.#agentsIn(r.root, r.prefix))]);

    const inventory = SessionInventory.load(this.transcriptPath, this.cwd);
    const deferred = [...inventory.deferredTools];
    return {
      skills: inventory.skills.size ? CatalogScanner.#mergeSkills(inventory, fileSkills) : fileSkills,
      agents: inventory.agents.size ? CatalogScanner.#mergeAgents(inventory, fileAgents) : fileAgents,
      tools: builtInTools(deferred),
      mcp: McpServerEntry.group(deferred, [...inventory.failedMcpServers]),
    };
  }

  /**
   * Uses the session's skill listing, enriched with `context: fork` from disk.
   * @param {SessionInventory} inventory
   * @param {SkillEntry[]} fileSkills
   * @returns {SkillEntry[]}
   */
  static #mergeSkills(inventory, fileSkills) {
    return [...inventory.skills.values()].map(listed => new SkillEntry({
      name: listed.name,
      description: listed.description,
      forkAgent: fileSkills.find(f => f.name === listed.name)?.forkAgent ?? null,
    }));
  }

  /**
   * Uses the session's agent listing, enriched with `skills:` preloads from disk.
   * @param {SessionInventory} inventory
   * @param {AgentEntry[]} fileAgents
   * @returns {AgentEntry[]}
   */
  static #mergeAgents(inventory, fileAgents) {
    return [...inventory.agents.values()].map(listed => {
      const file = fileAgents.find(f => f.name === listed.name);
      return new AgentEntry({
        name: listed.name,
        description: listed.description,
        tools: listed.tools,
        disallowedTools: listed.disallowedTools?.length ? listed.disallowedTools : (file?.disallowedTools ?? []),
        skills: file?.skills ?? [],
        builtIn: file?.builtIn ?? false,
      });
    });
  }

  /**
   * Merges `enabledPlugins` from user, project, and local settings; later scopes win.
   * @returns {Record<string, boolean>}
   */
  #enabledPlugins() {
    const files = [Paths.SETTINGS_FILE];
    if (this.cwd) {
      files.push(path.join(this.cwd, '.claude', 'settings.json'), path.join(this.cwd, '.claude', 'settings.local.json'));
    }
    return Object.assign({}, ...files.map(f => FsUtils.readJson(f)?.enabledPlugins ?? {}));
  }

  /**
   * Resolves install paths of enabled plugins applicable to this session.
   * @returns {{root: string, prefix: string}[]}
   */
  #pluginRoots() {
    const enabled = this.#enabledPlugins();
    const installed = FsUtils.readJson(Paths.INSTALLED_PLUGINS_FILE)?.plugins ?? {};

    return Object.entries(installed).flatMap(([id, installs]) => {
      const name = id.split('@')[0];
      if (enabled[id] !== true || name === CatalogScanner.SELF) return [];
      const install = installs.find(i => i.scope !== 'local' || this.cwd?.startsWith(i.projectPath));
      return install ? [{ root: install.installPath, prefix: `${name}:` }] : [];
    });
  }

  /**
   * @param {string} root Directory holding skills, or a plugin root.
   * @param {string} prefix Name prefix.
   * @returns {SkillEntry[]}
   */
  #skillsIn(root, prefix) {
    return this.#manifestPaths(root, 'skills')
      .flatMap(p => (fs.existsSync(path.join(p, 'SKILL.md')) ? [p] : FsUtils.listDirs(p)))
      .map(dir => FsUtils.readFrontmatter(path.join(dir, 'SKILL.md')))
      .filter(Boolean)
      .map(fm => SkillEntry.fromFrontmatter(fm, prefix))
      .filter(Boolean);
  }

  /**
   * @param {string} root Directory holding agents, or a plugin root.
   * @param {string} prefix Name prefix.
   * @returns {AgentEntry[]}
   */
  #agentsIn(root, prefix) {
    return this.#manifestPaths(root, 'agents')
      .flatMap(p => (p.endsWith('.md') ? [p] : FsUtils.listFiles(p, '.md')))
      .map(file => FsUtils.readFrontmatter(file))
      .filter(Boolean)
      .map(fm => AgentEntry.fromFrontmatter(fm, prefix));
  }

  /**
   * Returns the locations for `skills` or `agents`. A plugin's `plugin.json`
   * may override the default folder with a path or a list of paths.
   * @param {string} root Root directory.
   * @param {'skills'|'agents'} field Manifest field / default folder name.
   * @returns {string[]} Absolute paths to scan.
   */
  #manifestPaths(root, field) {
    const value = FsUtils.readJson(path.join(root, '.claude-plugin', 'plugin.json'))?.[field];
    if (!value) return [path.join(root, field)];
    return (Array.isArray(value) ? value : [value]).map(p => path.join(root, p));
  }

  /**
   * Keeps the first entry for each name.
   * @template {{name: string}} T
   * @param {T[]} entries
   * @returns {T[]}
   */
  static #dedupe(entries) {
    const seen = new Set();
    return entries.filter(e => !seen.has(e.name) && seen.add(e.name));
  }
}
