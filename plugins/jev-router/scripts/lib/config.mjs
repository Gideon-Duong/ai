import path from 'node:path';
import { FsUtils } from './fs-utils.mjs';
import { Paths } from './paths.mjs';

/**
 * Router settings. Defaults can be overridden in `~/.claude/jev-router/config.json`.
 */
export class Config {
  /** Default values for every setting. */
  static DEFAULTS = Object.freeze({
    model: 'jev-latest',
    threshold: 0.6,
    actionableThreshold: 0.5,
    toolThreshold: 0.7,
    mcpThreshold: 0.75,
    contextChars: 1500,
    planThreshold: 0.7,
    maxSkills: 3,
    maxAgents: 2,
    maxTools: 3,
    maxMcp: 2,
    maxMcpDescChars: 700,
    parallelThreshold: 0.7,
    assignConfidence: 0.5,
    speculativeExecutors: false,
    timeoutMs: 2500,
    minPromptChars: 12,
    maxDescChars: 300,
    exclude: [],
    log: true,
  });

  /**
   * @param {Partial<typeof Config.DEFAULTS>} [overrides] Values that replace the defaults.
   */
  constructor(overrides = {}) {
    const values = { ...Config.DEFAULTS, ...overrides };

    /** @type {string} Jev model alias or versioned ID. */
    this.model = values.model;
    /** @type {number} Minimum Noul probability for a skill or subagent to be suggested. */
    this.threshold = values.threshold;
    /** @type {number} Minimum probability for a built-in tool to be suggested. */
    this.toolThreshold = values.toolThreshold;
    /** @type {number} Minimum probability for an MCP server to be suggested. */
    this.mcpThreshold = values.mcpThreshold;
    /** @type {number} Characters of the previous assistant reply sent as context; 0 disables it. */
    this.contextChars = values.contextChars;
    /** @type {number} Minimum probability that the prompt asks for work; below it nothing is suggested. */
    this.actionableThreshold = values.actionableThreshold;
    /** @type {number} Minimum probability for the "plan first" hint. */
    this.planThreshold = values.planThreshold;
    /** @type {number} Maximum number of skills suggested per prompt. */
    this.maxSkills = values.maxSkills;
    /** @type {number} Maximum number of subagents suggested per prompt. */
    this.maxAgents = values.maxAgents;
    /** @type {number} Maximum number of built-in tools suggested per prompt. */
    this.maxTools = values.maxTools;
    /** @type {number} Maximum number of MCP servers suggested per prompt. */
    this.maxMcp = values.maxMcp;
    /** @type {number} MCP server descriptions (tool name lists) are truncated to this length. */
    this.maxMcpDescChars = values.maxMcpDescChars;
    /** @type {number} Minimum probability for the "run subagents in parallel" hint. */
    this.parallelThreshold = values.parallelThreshold;
    /** @type {number} Minimum confidence to assign a skill to a subagent; below it the skill stays with the main agent. */
    this.assignConfidence = values.assignConfidence;
    /** @type {boolean} Ask "who runs this skill" for every skill in the first request instead of a second request. */
    this.speculativeExecutors = values.speculativeExecutors;
    /** @type {number} Timeout for each Jev request in milliseconds. */
    this.timeoutMs = values.timeoutMs;
    /** @type {number} Prompts shorter than this are skipped. */
    this.minPromptChars = values.minPromptChars;
    /** @type {number} Descriptions are truncated to this length before sending. */
    this.maxDescChars = values.maxDescChars;
    /** @type {string[]} Skill, agent, tool, or MCP server names that are never suggested. */
    this.exclude = values.exclude;
    /** @type {boolean} Whether decisions are appended to `log.jsonl`. */
    this.log = values.log;
  }

  /**
   * Loads the user's config file, falling back to defaults when it is absent or invalid.
   * @returns {Config}
   */
  static load() {
    return new Config(FsUtils.readJson(path.join(Paths.DATA_DIR, 'config.json')) ?? {});
  }
}
