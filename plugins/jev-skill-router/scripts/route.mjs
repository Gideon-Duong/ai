#!/usr/bin/env node
/**
 * Entry point for the `UserPromptSubmit` hook.
 *
 * Asks TypeSafe Jev which skills and subagents fit the prompt and injects
 * them as `additionalContext`. Always exits 0 so the prompt is never blocked.
 *
 * Usage:
 *   node route.mjs                 # hook mode, reads JSON from stdin
 *   node route.mjs --test "<text>" # print suggestions for a prompt
 */
import { HookRunner } from './lib/hook-runner.mjs';

try {
  const { runner, input } = HookRunner.fromArgv(process.argv);
  await runner.run(input ?? await HookRunner.readStdin());
} catch {
  /** Fail-open: never block the prompt. */
} finally {
  process.exit(0);
}
