/**
 * Loop-resume checkpoints: the mechanism that makes iterations crash-safe.
 *
 * After every iteration the worker serializes the ENTIRE loop context into
 * the job row's `checkpoint` column:
 *   - the opening system messages (base prompt + plan + acceptance criteria),
 *     preserved verbatim so a resumed loop never loses its instructions;
 *   - a rolling tail of recent non-system messages (bounded, default 30),
 *     which keeps the context window finite no matter how long the run gets;
 *   - the round counter, failure counters, and serialized guard state.
 *
 * The next iteration: possibly on a different worker, after a crash or a
 * deploy: rebuilds the loop from this checkpoint alone. Nothing else is
 * needed. This is what "the worker must never cut off mid-work" reduces to
 * in practice: a ~2KB JSON blob written after every step.
 */
import type { ChatMessage, LoopCheckpoint, LoopGuardState } from "./types.ts";

export const CHECKPOINT_TAIL_LIMIT = 30;
export const CHECKPOINT_SYSTEM_LIMIT = 10;

export function emptyGuard(): LoopGuardState {
  return { seenToolCalls: {}, noopMutations: {}, unavailableTools: [] };
}

export function emptyCheckpoint(systemPrompt: string): LoopCheckpoint {
  return {
    systemMessages: [{ role: "system", content: systemPrompt }],
    tailMessages: [],
    round: 0,
    consecutiveToolFailures: 0,
    readOnlyRounds: 0,
    guard: emptyGuard(),
  };
}

export interface CheckpointInput {
  thinkText?: string;
  messages: ChatMessage[];
  round: number;
  consecutiveToolFailures: number;
  readOnlyRounds: number;
  guard: LoopGuardState;
  files?: Array<{ path: string; content: string }>;
  done?: boolean;
  completion?: string;
}

/** Build the checkpoint payload written to the job row after each iteration. */
export function buildCheckpoint(input: CheckpointInput): LoopCheckpoint {
  // System messages carry the plan: slice only the TAIL of the conversation,
  // never the head, or a resumed loop wakes up with no instructions.
  const systemMessages = input.messages
    .filter((m) => m.role === "system")
    .slice(0, CHECKPOINT_SYSTEM_LIMIT);
  const tailMessages = input.messages
    .filter((m) => m.role !== "system")
    .slice(-CHECKPOINT_TAIL_LIMIT);

  return {
    systemMessages,
    tailMessages,
    round: input.round,
    consecutiveToolFailures: input.consecutiveToolFailures,
    readOnlyRounds: input.readOnlyRounds,
    guard: input.guard,
    ...(input.files ? { files: input.files } : {}),
    ...(input.done ? { done: true, completion: input.completion } : {}),
  };
}

/** Rebuild the working message list from a stored checkpoint. */
export function restoreMessages(cp: LoopCheckpoint): ChatMessage[] {
  return [...(cp.systemMessages ?? []), ...(cp.tailMessages ?? [])];
}

/** Canonical signature for loop detection: same tool + same args = repeat. */
export function toolCallSignature(name: string, argsJson: string): string {
  let normalized = argsJson;
  try {
    normalized = JSON.stringify(
      JSON.parse(argsJson),
      Object.keys(JSON.parse(argsJson)).sort(),
    );
  } catch {
    // keep raw when args aren't valid JSON
  }
  return `${name}(${normalized})`;
}
