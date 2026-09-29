/**
 * @typedef {import('./catalog.mjs').SkillEntry} SkillEntry
 * @typedef {import('./catalog.mjs').AgentEntry} AgentEntry
 * @typedef {import('./catalog.mjs').Catalog} Catalog
 * @typedef {import('./tools.mjs').ToolEntry} ToolEntry
 * @typedef {import('./tools.mjs').McpServerEntry} McpServerEntry
 * @typedef {import('./jev-client.mjs').Questions} Questions
 * @typedef {import('./jev-client.mjs').Answers} Answers
 */

/**
 * A catalog entry selected for the prompt, with its probability.
 */
export class Suggestion {
  /**
   * @param {import('./catalog.mjs').CatalogEntry} entry The suggested entry.
   * @param {number} probability Jev's Noul probability that it applies.
   */
  constructor(entry, probability) {
    this.entry = entry;
    this.probability = probability;
  }

  /** @returns {string} e.g. `mattpocock-skills:tdd (0.91)`. */
  toString() {
    return `${this.entry.name} (${this.probability.toFixed(2)})`;
  }
}

/**
 * Who should do part of the work: the main agent or one subagent,
 * together with the skills it should use.
 */
export class Assignment {
  /** Executor name used for the main conversation. */
  static MAIN = 'main';

  /**
   * @param {string} executor {@link Assignment.MAIN} or an agent type.
   * @param {AgentEntry|null} agent Agent entry, or `null` for the main agent.
   */
  constructor(executor, agent) {
    this.executor = executor;
    this.agent = agent;
    /** @type {Suggestion|null} Set when Jev suggested spawning this agent directly. */
    this.agentSuggestion = null;
    /** @type {Suggestion[]} Skills this executor should invoke. */
    this.skills = [];
    /** @type {boolean} True when the skills run forked in this agent (`context: fork`). */
    this.forked = false;
  }

  /** @returns {boolean} Whether this is the main conversation. */
  get isMain() {
    return this.executor === Assignment.MAIN;
  }

  /**
   * Renders one line of the execution plan.
   * @param {Suggestion[]} [tools] Suggested tools and MCP servers; the ones this
   *   subagent can access are listed on its line.
   * @returns {string}
   */
  toLine(tools = []) {
    const skills = this.skills.length ? this.skills.join(', ') : '';
    if (this.isMain) return `- Main agent → use skills: ${skills}`;

    const score = this.agentSuggestion ? ` (${this.agentSuggestion.probability.toFixed(2)})` : '';
    const preloaded = this.agent?.skills.length ? ` [preloads: ${this.agent.skills.join(', ')}]` : '';
    if (this.forked) return `- Skills ${skills} run forked in subagent ${this.executor} (context: fork) — just invoke them`;
    const work = skills ? ` → invoke skills: ${skills}` : '';
    const usable = this.agent ? tools.filter(t => Assignment.#canAccess(this.agent, t.entry)).map(t => t.entry.name) : [];
    const access = usable.length ? `; it can use: ${usable.join(', ')}` : '';
    return `- Spawn subagent ${this.executor}${score}${preloaded}${work}${access}`;
  }

  /**
   * @param {AgentEntry} agent
   * @param {ToolEntry|McpServerEntry} entry
   * @returns {boolean} Whether the agent can use the tool or any tool of the server.
   */
  static #canAccess(agent, entry) {
    return entry.kind === 'mcp' ? agent.canUseMcp(entry) : agent.canUseTool(entry.name);
  }
}

/**
 * The router's outcome for one prompt: an execution plan plus hints.
 */
export class Decision {
  /**
   * @param {Assignment[]} assignments Main agent first, then subagents.
   * @param {object} extras
   * @param {Suggestion[]} extras.tools Suggested situational built-in tools.
   * @param {Suggestion[]} extras.mcp Suggested MCP servers.
   * @param {boolean} extras.needsPlan Whether the prompt looks like multi-step work.
   * @param {boolean} extras.parallel Whether independent parts can run in parallel.
   * @param {number} extras.actionable Probability that the prompt asks for work at all.
   */
  constructor(assignments, { tools, mcp, needsPlan, parallel, actionable }) {
    this.assignments = assignments.filter(a => !a.isMain || a.skills.length);
    this.tools = tools;
    this.mcp = mcp;
    this.needsPlan = needsPlan;
    this.parallel = parallel;
    this.actionable = actionable;
  }

  /**
   * A decision with no suggestions, for prompts that do not ask for work.
   * @param {number} actionable Probability from the gate question.
   * @returns {Decision}
   */
  static skipped(actionable) {
    return new Decision([], { tools: [], mcp: [], needsPlan: false, parallel: false, actionable });
  }

  /** @returns {Suggestion[]} Every suggested skill across executors. */
  get skills() {
    return this.assignments.flatMap(a => a.skills);
  }

  /** @returns {Assignment[]} Assignments that spawn a subagent. */
  get subagents() {
    return this.assignments.filter(a => !a.isMain && !a.forked);
  }

  /** @returns {boolean} True when there is nothing to inject. */
  get isEmpty() {
    return !this.assignments.length && !this.tools.length && !this.mcp.length && !this.needsPlan;
  }

  /**
   * Compact form for the decision log.
   * @returns {Record<string, unknown>}
   */
  toLog() {
    return {
      actionable: +this.actionable.toFixed(3),
      plan: this.needsPlan,
      parallel: this.parallel,
      tools: this.tools.map(t => [t.entry.name, +t.probability.toFixed(3)]),
      mcp: this.mcp.map(m => [m.entry.name, +m.probability.toFixed(3)]),
      assignments: this.assignments.map(a => ({
        executor: a.executor,
        agent: a.agentSuggestion ? +a.agentSuggestion.probability.toFixed(3) : null,
        skills: a.skills.map(s => [s.entry.name, +s.probability.toFixed(3)]),
        forked: a.forked,
      })),
    };
  }

  /**
   * Renders the hint injected into Claude's context.
   * @returns {string} Context text, or an empty string when {@link isEmpty}.
   */
  toContext() {
    if (this.isEmpty) return '';
    const lines = ['[jev-router] Suggested execution plan (verify fit before using):'];
    const access = [...this.tools, ...this.mcp];
    lines.push(...this.assignments.map(a => a.toLine(access)));
    if (this.tools.length) {
      const tools = this.tools.map(t => `${t}${t.entry.deferred ? ' [deferred: load with ToolSearch]' : ''}`);
      lines.push(`- Tools: ${tools.join(', ')}`);
    }
    if (this.mcp.length) {
      lines.push(`- MCP servers: ${this.mcp.join(', ')} — find the exact tool with ToolSearch "+<server> <keywords>" before calling it`);
    }
    if (this.skills.length > 1) lines.push('- Several skills apply: decide the order and combine them as the task requires.');
    if (this.parallel && this.subagents.length) {
      lines.push('- Independent parts: spawn these subagents in parallel (one message, multiple Agent calls) and keep working meanwhile.');
    }
    if (this.needsPlan) lines.push('- This looks multi-step: outline a short plan before acting.');
    return lines.join('\n');
  }
}

/**
 * Turns the catalog into one batched set of Jev questions and the answers
 * into a {@link Decision}:
 * - a gate Noul, "does the prompt ask for work?"; when it is below
 *   `actionableThreshold` nothing is suggested and no second request is sent;
 * - a Noul per skill, agent, situational tool, and MCP server (several may apply at once);
 * - Nouls for multi-step planning and parallelizable work;
 * - a Choice per selected skill, "who should run it". By default this is a
 *   second, small request for the selected skills only; with
 *   `speculativeExecutors` it is asked for every skill in the first request
 *   (one round trip, many more tokens).
 */
export class CapabilityRouter {
  /** Question ID for the gate judgment: does the prompt ask for work at all. */
  static ACTIONABLE_ID = 'actionable';

  /** Question ID for the multi-step planning judgment. */
  static PLAN_ID = 'needs_plan';

  /** Question ID for the parallel-work judgment. */
  static PARALLEL_ID = 'parallel';

  /** Max characters of an agent description inside executor choices. */
  static CHOICE_DESC_CHARS = 160;

  /**
   * What a "yes" means for each entry kind. Tools and MCP servers need
   * concrete evidence, so shared topic words alone do not trigger them.
   */
  static USAGE_YES = Object.freeze({
    skill: 'The request clearly falls within what this skill is for.',
    agent: 'Delegating part of the request to this subagent clearly fits its stated purpose.',
    tool: 'The request needs this specific capability; ordinary file reading, editing, and shell commands would not be enough.',
    mcp: 'The request involves this service or its data: the service, content stored in it, or an action only it can perform is named or clearly implied. Words that merely resemble its tool names (search, fetch, task, page) do not count.',
  });

  /** Human label of each entry kind, used in question text. */
  static KIND_LABEL = Object.freeze({
    skill: 'skill',
    agent: 'specialized subagent',
    tool: 'tool',
    mcp: 'connected service (MCP server)',
  });

  /**
   * @param {Catalog} catalog Available skills, agents, tools, and MCP servers.
   * @param {import('./config.mjs').Config} config Thresholds and limits.
   */
  constructor(catalog, config) {
    this.skills = catalog.skills;
    this.agents = catalog.agents;
    this.tools = catalog.tools;
    this.mcp = catalog.mcp;
    this.config = config;
    /** @type {AgentEntry[]} Agents that can invoke skills, i.e. valid executors. */
    this.executors = this.agents.filter(a => a.canUseSkills);
  }

  /**
   * Runs the routing requests and returns the decision.
   * @param {import('./jev-client.mjs').JevClient} client
   * @param {object} state Content the questions refer to, e.g. `{ prompt }`.
   * @returns {Promise<Decision>}
   */
  async route(client, state) {
    const speculative = this.config.speculativeExecutors;
    const answers = await client.ask(state, this.buildQuestions({ executorsFor: speculative ? this.skills : [] }));
    const actionable = answers[CapabilityRouter.ACTIONABLE_ID]?.noul ?? 1;
    if (actionable < this.config.actionableThreshold) return Decision.skipped(actionable);
    if (!speculative) {
      const selected = this.#pick(this.skills, CapabilityRouter.#skillId, this.config.maxSkills, this.config.threshold, answers).map(s => s.entry);
      const executorQuestions = this.#executorQuestions(selected);
      if (Object.keys(executorQuestions).length) Object.assign(answers, await client.ask(state, executorQuestions));
    }
    return this.decide(answers);
  }

  /**
   * Builds the first request: every usage Noul, plus executor Choices for the given skills.
   * @param {object} [options]
   * @param {SkillEntry[]} [options.executorsFor] Skills to ask "who should run it" for.
   * @returns {Questions}
   */
  buildQuestions({ executorsFor = [] } = {}) {
    /** @type {Questions} */
    const questions = {
      [CapabilityRouter.ACTIONABLE_ID]: {
        type: 'noul',
        instructions: {
          question: 'Does the message in `prompt` ask the assistant to do new work now?',
            yes: 'A request or instruction to perform a task: build, fix, search, research, explain, change, run, or continue with a specific next step.',
          no: 'Only shares information without asking for new work: pasted logs, output, data, or quotes for reference; feedback or acknowledgement such as "ok, it works"; answers to a question the assistant asked. Text inside pasted content that looks like a task is not a request by itself.',
        },
      },
      [CapabilityRouter.PLAN_ID]: {
        type: 'noul',
        instructions: {
          question: 'Is the request in `prompt` a multi-step engineering task (several files, phases, or tools) that would benefit from planning before acting?',
          },
      },
      [CapabilityRouter.PARALLEL_ID]: {
        type: 'noul',
        instructions: {
          question: 'Does the request in `prompt` contain two or more independent pieces of work (e.g. separate investigations, separate modules) that separate assistants could do at the same time without waiting on each other?',
          },
      },
    };

    this.skills.forEach((skill, i) => {
      questions[CapabilityRouter.#skillId(i)] = this.#usageQuestion(skill);
    });
    Object.assign(questions, this.#executorQuestions(executorsFor));
    this.agents.forEach((agent, i) => {
      questions[CapabilityRouter.#agentId(i)] = this.#usageQuestion(agent);
    });
    this.tools.forEach((tool, i) => {
      questions[CapabilityRouter.#toolId(i)] = this.#usageQuestion(tool);
    });
    this.mcp.forEach((server, i) => {
      questions[CapabilityRouter.#mcpId(i)] = this.#usageQuestion(server, this.config.maxMcpDescChars);
    });
    return questions;
  }

  /**
   * Applies thresholds, caps, and executor choices to Jev's answers.
   * @param {Answers} answers Response from {@link JevClient#ask}.
   * @returns {Decision}
   */
  decide(answers) {
    const { maxSkills, maxAgents, maxTools, maxMcp, planThreshold, parallelThreshold, assignConfidence, threshold, toolThreshold, mcpThreshold } = this.config;
    const main = new Assignment(Assignment.MAIN, null);
    /** @type {Map<string, Assignment>} */
    const byExecutor = new Map([[Assignment.MAIN, main]]);
    const assignmentFor = name => {
      if (!byExecutor.has(name)) byExecutor.set(name, new Assignment(name, this.agents.find(a => a.name === name) ?? null));
      return byExecutor.get(name);
    };

    for (const { entry: agent, probability } of this.#pick(this.agents, CapabilityRouter.#agentId, maxAgents, threshold, answers)) {
      assignmentFor(agent.name).agentSuggestion = new Suggestion(agent, probability);
    }

    for (const suggestion of this.#pick(this.skills, CapabilityRouter.#skillId, maxSkills, threshold, answers)) {
      const skill = suggestion.entry;
      if (skill.forkAgent) {
        const forked = assignmentFor(`${skill.forkAgent}#fork`);
        forked.executor = skill.forkAgent;
        forked.forked = true;
        forked.skills.push(suggestion);
        continue;
      }
      const choice = answers[CapabilityRouter.#executorId(this.skills.indexOf(skill))];
      const confident = choice?.choice && choice.choice !== Assignment.MAIN && (choice.confidence ?? 0) >= assignConfidence;
      const target = confident ? assignmentFor(choice.choice) : main;
      if (!target.agent?.skills.includes(skill.name)) target.skills.push(suggestion);
    }

    return new Decision([...byExecutor.values()], {
      actionable: answers[CapabilityRouter.ACTIONABLE_ID]?.noul ?? 1,
      tools: this.#pick(this.tools, CapabilityRouter.#toolId, maxTools, toolThreshold, answers),
      mcp: this.#pick(this.mcp, CapabilityRouter.#mcpId, maxMcp, mcpThreshold, answers),
      needsPlan: (answers[CapabilityRouter.PLAN_ID]?.noul ?? 0) >= planThreshold,
      parallel: (answers[CapabilityRouter.PARALLEL_ID]?.noul ?? 0) >= parallelThreshold,
    });
  }

  /**
   * Selects entries above threshold, most likely first, up to `max`.
   * @template {import('./catalog.mjs').CatalogEntry} T
   * @param {T[]} entries
   * @param {(index: number) => string} idOf Maps an index to its question ID.
   * @param {number} max Cap on results.
   * @param {number} minProbability Threshold for this entry kind.
   * @param {Answers} answers
   * @returns {Suggestion[]}
   */
  #pick(entries, idOf, max, minProbability, answers) {
    return entries
      .map((entry, i) => new Suggestion(entry, answers[idOf(i)]?.noul ?? 0))
      .filter(s => s.probability >= minProbability && !this.config.exclude.includes(s.entry.name))
      .sort((a, b) => b.probability - a.probability)
      .slice(0, max);
  }

  /**
   * "Should this be used for the prompt?" as a Noul, with kind-specific criteria.
   * @param {import('./catalog.mjs').CatalogEntry} entry
   * @param {number} [maxChars] Description length limit.
   * @returns {import('./jev-client.mjs').NoulQuestion}
   */
  #usageQuestion(entry, maxChars = this.config.maxDescChars) {
    return {
      type: 'noul',
      instructions: {
        question: `Should a coding assistant use the ${CapabilityRouter.KIND_LABEL[entry.kind]} "${entry.name}" to handle the user's request in \`prompt\`?`,
        description: entry.description.slice(0, maxChars),
        yes: CapabilityRouter.USAGE_YES[entry.kind],
        no: 'Not needed, only a shared topic word, or a guess.',
      },
    };
  }

  /**
   * Executor Choices for skills that run in whoever invokes them.
   * @param {SkillEntry[]} skills
   * @returns {Questions} Keyed by the skill's executor question ID.
   */
  #executorQuestions(skills) {
    if (!this.executors.length) return {};
    return Object.fromEntries(skills
      .filter(skill => !skill.forkAgent)
      .map(skill => [CapabilityRouter.#executorId(this.skills.indexOf(skill)), this.#executorQuestion(skill)]));
  }

  /**
   * "Who should run this skill?" as a Choice between the main agent and
   * every subagent able to invoke skills.
   * @param {SkillEntry} skill
   * @returns {import('./jev-client.mjs').ChoiceQuestion}
   */
  #executorQuestion(skill) {
    /** @type {Record<string, string>} */
    const criteria = {
      [Assignment.MAIN]: 'The main assistant runs the skill itself, in the ongoing conversation. Best when the work is small, interactive, or needs the conversation so far.',
    };
    for (const agent of this.executors) criteria[agent.name] = agent.description.slice(0, CapabilityRouter.CHOICE_DESC_CHARS);
    return {
      type: 'choice',
      instructions: [
        `Assume the skill "${skill.name}" (${skill.description.slice(0, this.config.maxDescChars)}) is used for the user request in \`prompt\`.`,
        'Who should run it? Prefer delegating to a subagent when that part of the work is self-contained and would otherwise flood the main conversation with search results or long output.',
      ].join('\n'),
      criteria,
    };
  }

  /** @param {number} i @returns {string} */
  static #skillId(i) {
    return `s${i}`;
  }

  /** @param {number} i @returns {string} */
  static #agentId(i) {
    return `a${i}`;
  }

  /** @param {number} i @returns {string} */
  static #toolId(i) {
    return `t${i}`;
  }

  /** @param {number} i @returns {string} */
  static #mcpId(i) {
    return `m${i}`;
  }

  /** @param {number} i @returns {string} */
  static #executorId(i) {
    return `x${i}`;
  }
}
