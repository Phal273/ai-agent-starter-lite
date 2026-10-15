/**
 * Tool registry + tool-round executor.
 *
 * The agent loop works in ROUNDS: the model emits tool calls, the executor
 * runs every call in the round (sequentially: deterministic and easier to
 * attribute failures), appends the results as `tool` messages, and asks the
 * model again. The round ends when the model emits no more tool calls, or a
 * per-iteration cap is hit.
 *
 * Guardrails baked in (generalized from production):
 *  - loop detection: identical tool+args repeated N times → stop the round
 *    and tell the model it's looping;
 *  - failure budget: consecutive tool failures past the cap end the round;
 *  - unavailable tools are remembered for the rest of the run (serialized in
 *    the checkpoint guard) so a resumed loop doesn't retry them forever.
 */
import type {
  AgentTool,
  ChatMessage,
  LlmToolCall,
  LoopGuardState,
  ToolCallRecord,
  ToolContext,
  ToolResult,
} from "./types.ts";
import { toolCallSignature } from "./checkpoint.ts";

export const MAX_TOOL_CALLS_PER_ROUND = 8;
export const MAX_CONSECUTIVE_TOOL_FAILURES = 4;
export const MAX_REPEATED_TOOL_CALL = 3;

export interface ExecuteRoundOptions {
  tools: Map<string, AgentTool>;
  ctx: ToolContext;
  guard: LoopGuardState;
  /** Hard cap on tool calls this round (default 8). */
  maxCalls?: number;
}

/** Run one tool round. Mutates `messages` in place; returns the records. */
export async function executeToolRound(
  messages: ChatMessage[],
  calls: LlmToolCall[],
  opts: ExecuteRoundOptions,
): Promise<{ records: ToolCallRecord[]; stoppedReason: string | null }> {
  const maxCalls = opts.maxCalls ?? MAX_TOOL_CALLS_PER_ROUND;
  const records: ToolCallRecord[] = [];
  let consecutiveFailures = 0;

  // The model's tool_calls live on its assistant message; results go back as
  // `tool` messages referencing each call id.
  const pending = calls.slice(0, maxCalls);

  for (const call of pending) {
    const sig = toolCallSignature(call.name, call.arguments);
    opts.guard.seenToolCalls[sig] = (opts.guard.seenToolCalls[sig] ?? 0) + 1;

    if (opts.guard.seenToolCalls[sig] > MAX_REPEATED_TOOL_CALL) {
      const result: ToolResult = {
        ok: false,
        error:
          `Loop guard: you've called ${call.name} with identical arguments ` +
          `${opts.guard.seenToolCalls[sig]} times. Stop repeating it: try a different approach or finish.`,
      };
      messages.push({
        role: "tool",
        content: result.error,
        tool_call_id: call.id,
      });
      records.push({
        ...call,
        result: result.error,
        durationMs: 0,
        ok: false,
      });
      return { records, stoppedReason: "loop_detected" };
    }

    const tool = opts.tools.get(call.name);
    const started = Date.now();
    let result: ToolResult;
    if (!tool) {
      if (!opts.guard.unavailableTools.includes(call.name)) {
        opts.guard.unavailableTools.push(call.name);
      }
      result = { ok: false, error: `Unknown tool: ${call.name}` };
    } else {
      let args: Record<string, unknown>;
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        args = {};
      }
      try {
        result = await tool.handler(args, opts.ctx);
      } catch (err) {
        result = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    const durationMs = Date.now() - started;
    const output = result.ok ? result.output : `Error: ${result.error}`;

    messages.push({ role: "tool", content: output, tool_call_id: call.id });
    records.push({ ...call, result: output, durationMs, ok: result.ok });

    if (result.ok) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
        return { records, stoppedReason: "too_many_failures" };
      }
    }
  }

  return {
    records,
    stoppedReason: calls.length > maxCalls ? "call_cap" : null,
  };
}

/** Convenience: build a name→tool map from an array. */
export function toolMap(tools: AgentTool[]): Map<string, AgentTool> {
  return new Map(tools.map((t) => [t.name, t]));
}
