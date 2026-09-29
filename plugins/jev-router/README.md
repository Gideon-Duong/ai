# jev-router

Claude Code plugin. On every prompt, a `UserPromptSubmit` hook asks [TypeSafe Jev](https://docs.typesafe.ai)
which of your installed skills and subagents fit the request, and injects the matches as context.
Several skills can match at once (one Noul per skill), plus a "plan first" hint for multi-step work.

## Install

```
/plugin marketplace add Gideon-Duong/ai
/plugin install jev-router@gideon-ai
```

When the plugin is enabled, Claude Code prompts for your **TypeSafe API key** (masked, stored in the
OS secure credential store, not `settings.json`). Change it later via `/plugin` → jev-router →
configure. For local runs outside Claude Code, `TYPESAFE_API_KEY` is used as a fallback.

Requires Node 18+. No npm dependencies.

## How it works

1. **Inventory** — reads what Claude Code actually loaded into the session from the transcript
   (`transcript_path`): skill listing, agent listing (with each agent's tools), deferred tools,
   MCP tools, and MCP servers that failed to connect. The last inventory is cached per project in
   `~/.claude/jev-router/inventory/` for the first prompt of a new session. Files on disk add
   `context: fork` (skills) and `skills:` preloads (agents); without a transcript they are used alone.
2. **Request 1** (`POST /v1/systemone`): a Noul per skill, agent, situational built-in tool
   (WebSearch, LSP, Monitor, ...), and MCP server (judged by its tool names), plus `needs_plan`
   and `parallel`. MCP servers that only expose sign-in tools are skipped.
3. **Request 2** (only when skills were selected): a Choice per selected skill — run it in the main
   agent or in a subagent that has the `Skill` tool. Set `speculativeExecutors: true` to fold this
   into request 1 (one round trip, ~3x tokens).
4. **Plan** — main-agent skills, subagents to spawn with their skills and the suggested tools/MCP
   they can access, `context: fork` skills, tools (flagged when deferred), MCP servers, and
   parallel/plan hints, injected as `additionalContext`.
5. **Fail-open** — missing key, timeout, or API error → no output, prompt proceeds unchanged.

Example context injected for Claude:

```
[jev-router] Suggested execution plan (verify fit before using):
- Main agent → use skills: mattpocock-skills:diagnosing-bugs (0.92)
- Spawn subagent general-purpose → invoke skills: wigolo-research (0.85); it can use: WebSearch, claude_ai_Notion
- Tools: WebSearch (0.70) [deferred: load with ToolSearch]
- MCP servers: claude_ai_Notion (0.88) — find the exact tool with ToolSearch "+<server> <keywords>" before calling it
- Independent parts: spawn these subagents in parallel (one message, multiple Agent calls) and keep working meanwhile.
```

## Config

Optional `~/.claude/jev-router/config.json`:

```json
{
  "threshold": 0.6,
  "planThreshold": 0.7,
  "maxSkills": 3,
  "maxAgents": 2,
  "parallelThreshold": 0.7,
  "assignConfidence": 0.5,
  "maxTools": 3,
  "maxMcp": 2,
  "speculativeExecutors": false,
  "timeoutMs": 2500,
  "exclude": ["graphify"],
  "log": true
}
```

Decisions are logged to `~/.claude/jev-router/log.jsonl` (prompt preview, latency, picks) for tuning.

## Test locally

```
node plugins/jev-router/scripts/route.mjs --test "diagnose this failing test"
JEV_ROUTER_TRANSCRIPT=~/.claude/projects/<project>/<session>.jsonl node ... --test "..."   # use a real session inventory
JEV_ROUTER_MOCK=1 node plugins/jev-router/scripts/route.mjs --test "..."   # offline, keyword mock
claude --plugin-dir ./plugins/jev-router
```
