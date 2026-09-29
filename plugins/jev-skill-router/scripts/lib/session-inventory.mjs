import fs from 'node:fs';
import path from 'node:path';
import { FsUtils } from './fs-utils.mjs';
import { Paths } from './paths.mjs';

/**
 * @typedef {object} ListedAgent
 * @property {string} name Agent type.
 * @property {string} description Delegation description.
 * @property {string[]|null} tools Tool allowlist, `null` for every tool.
 * @property {string[]} disallowedTools Tools excluded from "All tools except ...".
 */

/**
 * @typedef {object} ListedSkill
 * @property {string} name Skill name.
 * @property {string} description Skill description.
 */

/**
 * What Claude Code actually loaded into the session, read from the
 * transcript's listing attachments (`deferred_tools_delta`,
 * `agent_listing_delta`, `skill_listing`). This is the ground truth for
 * tools, MCP tools, agents, and model-invocable skills.
 *
 * The first prompt of a session may run before these attachments are
 * written, so the last inventory is cached per project and reused.
 */
export class SessionInventory {
  /** Attachment types this class reads. */
  static TYPES = ['deferred_tools_delta', 'agent_listing_delta', 'skill_listing'];

  constructor() {
    /** @type {Set<string>} Deferred tool names, including every MCP tool. */
    this.deferredTools = new Set();
    /** @type {Set<string>} MCP servers that failed to connect. */
    this.failedMcpServers = new Set();
    /** @type {Map<string, ListedAgent>} */
    this.agents = new Map();
    /** @type {Map<string, ListedSkill>} */
    this.skills = new Map();
  }

  /** @returns {boolean} True when nothing was found. */
  get isEmpty() {
    return !this.deferredTools.size && !this.agents.size && !this.skills.size;
  }

  /**
   * Loads the inventory for a session, falling back to the cached one.
   * @param {string|undefined} transcriptPath `transcript_path` from the hook input.
   * @param {string|undefined} cwd Project directory, used as cache key.
   * @returns {SessionInventory}
   */
  static load(transcriptPath, cwd) {
    const cacheFile = SessionInventory.#cacheFile(cwd);
    const inventory = transcriptPath ? SessionInventory.fromTranscript(transcriptPath) : new SessionInventory();
    if (!inventory.isEmpty) {
      inventory.#save(cacheFile);
      return inventory;
    }
    return SessionInventory.#restore(cacheFile) ?? inventory;
  }

  /**
   * Replays listing attachments in order, applying added/removed deltas.
   * @param {string} file Transcript JSONL path.
   * @returns {SessionInventory}
   */
  static fromTranscript(file) {
    const inventory = new SessionInventory();
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return inventory;
    }
    for (const line of text.split('\n')) {
      if (!SessionInventory.TYPES.some(t => line.includes(`"${t}"`))) continue;
      let attachment;
      try {
        attachment = JSON.parse(line).attachment;
      } catch {
        continue;
      }
      inventory.#apply(attachment);
    }
    return inventory;
  }

  /**
   * Applies one attachment to the inventory.
   * @param {Record<string, any>|undefined} attachment
   */
  #apply(attachment) {
    switch (attachment?.type) {
      case 'deferred_tools_delta':
        this.#applyTools(attachment);
        break;
      case 'agent_listing_delta':
        this.#applyAgents(attachment);
        break;
      case 'skill_listing':
        this.#applySkills(attachment);
        break;
      default:
        break;
    }
  }

  /**
   * Adds and removes deferred tools; records MCP servers that failed to connect.
   * @param {Record<string, any>} attachment `deferred_tools_delta` attachment.
   */
  #applyTools(attachment) {
    for (const name of attachment.addedNames ?? []) this.deferredTools.add(name);
    for (const name of attachment.removedNames ?? []) this.deferredTools.delete(name);
    this.failedMcpServers = new Set((attachment.failedMcpServers ?? []).map(s => s.name));
  }

  /**
   * Applies an agent listing delta; an initial listing replaces the previous one.
   * @param {Record<string, any>} attachment `agent_listing_delta` attachment.
   */
  #applyAgents(attachment) {
    if (attachment.isInitial) this.agents.clear();
    for (const type of attachment.removedTypes ?? []) this.agents.delete(type);
    const added = (attachment.addedLines ?? []).map(line => SessionInventory.#parseAgentLine(line)).filter(Boolean);
    for (const agent of added) this.agents.set(agent.name, agent);
  }

  /**
   * Applies a skill listing; an initial listing replaces the previous one.
   * @param {Record<string, any>} attachment `skill_listing` attachment.
   */
  #applySkills(attachment) {
    if (attachment.isInitial) this.skills.clear();
    for (const skill of SessionInventory.#parseSkillListing(attachment.content ?? '')) this.skills.set(skill.name, skill);
  }

  /**
   * Parses `- name: description (Tools: A, B)` from the agent listing.
   * @param {string} line
   * @returns {ListedAgent|null}
   */
  static #parseAgentLine(line) {
    if (!line.startsWith('- ')) return null;
    const colon = line.indexOf(': ');
    if (colon < 0) return null;
    const name = line.slice(2, colon);
    let description = line.slice(colon + 2);
    let tools = null;
    let disallowedTools = [];
    const marker = description.lastIndexOf(' (Tools: ');
    if (marker >= 0 && description.endsWith(')')) {
      const list = description.slice(marker + ' (Tools: '.length, -1).trim();
      description = description.slice(0, marker);
      const except = 'All tools except ';
      if (list.startsWith(except)) disallowedTools = FsUtils.toList(list.slice(except.length));
      else if (list !== '*' && !list.startsWith('All tools')) tools = FsUtils.toList(list);
    }
    return { name, description, tools, disallowedTools };
  }

  /**
   * Parses the `- name: description` lines of a skill listing.
   * @param {string} content
   * @returns {ListedSkill[]}
   */
  static #parseSkillListing(content) {
    return content.split('\n').flatMap(line => {
      if (!line.startsWith('- ')) return [];
      const colon = line.indexOf(': ');
      return colon > 2 ? [{ name: line.slice(2, colon), description: line.slice(colon + 2) }] : [];
    });
  }

  /**
   * @param {string|undefined} cwd
   * @returns {string} Cache file for the project.
   */
  static #cacheFile(cwd) {
    const key = (cwd ?? 'global').replaceAll(/[^A-Za-z0-9]/g, '-');
    return path.join(Paths.DATA_DIR, 'inventory', `${key}.json`);
  }

  /** @param {string} file */
  #save(file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        deferredTools: [...this.deferredTools],
        failedMcpServers: [...this.failedMcpServers],
        agents: [...this.agents.values()],
        skills: [...this.skills.values()],
      }));
    } catch {
      /** Caching is best-effort. */
    }
  }

  /**
   * @param {string} file
   * @returns {SessionInventory|null}
   */
  static #restore(file) {
    const data = FsUtils.readJson(file);
    if (!data) return null;
    const inventory = new SessionInventory();
    inventory.deferredTools = new Set(data.deferredTools ?? []);
    inventory.failedMcpServers = new Set(data.failedMcpServers ?? []);
    inventory.agents = new Map((data.agents ?? []).map(a => [a.name, a]));
    inventory.skills = new Map((data.skills ?? []).map(s => [s.name, s]));
    return inventory;
  }
}
