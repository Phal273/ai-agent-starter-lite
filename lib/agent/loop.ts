/**
 * The iteration driver: one bounded step of an agent run.
 *
 * A worker calls `runIteration(job)` and gets back in well under 30 seconds.
 * The driver:
 *   1. restores the loop context from the job's checkpoint (messages, guard,
 *      files): a fresh worker needs nothing else;
 *   2. runs model turns until the DONE marker appears, the tool budget is
 *      spent, or the iteration deadline approaches;
 *   3. writes the new checkpoint back to the job row (heartbeat), records
 *      the iteration, and reports whether the job is done.
 *
 * Bounding rules that keep every iteration short:
 *   - MAX_TURNS_PER_ITERATION model turns (each turn = 1 LLM call + 1 tool round)
 *   - MAX_ITERATION_MS wall-clock deadline; the loop exits early and the
 *     checkpoint carries the run forward to the next iteration.
 *
 * Nothing here is product-specific: point it at any system prompt, any tool
 * set, any OpenAI-compatible model, and you have a durable agent loop.
 */
import {
  buildCheckpoint,
  emptyCheckpoint,
  emptyGuard,
  restoreMessages,
} from "./checkpoint.ts";
import { FileStore } from "./filestore.ts";
import { complete as llmComplete } from "./llm.ts";
import { buildSystemPrompt, parseDoneMarker } from "./prompts.ts";
import { executeToolRound, toolMap } from "./tools.ts";
import { defaultFileTools } from "./default-tools.ts";
import type {
  AgentJob,
  AgentTool,
  ChatMessage,
  IterationOutcome,
  LoopCheckpoint,
  ToolContext,
} from "./types.ts";

export const MAX_TURNS_PER_ITERATION = 4;
export const MAX_ITERATION_MS = 25_000;
export const MAX_JOB_ITERATIONS = 60;

export interface LoopConfig {
  purpose: string;
  extraInstructions?: string;
  tools?: AgentTool[];
  maxTurnsPerIteration?: number;
  maxIterationMs?: number;
  maxJobIterations?: number;
}

export async function runIteration(
  job: AgentJob,
  config: LoopConfig,
): Promise<IterationOutcome> {
  const startedAt = Date.now();
  const deadline = startedAt + (config.maxIterationMs ?? MAX_ITERATION_MS);
  const maxTurns = config.maxTurnsPerIteration ?? MAX_TURNS_PER_ITERATION;
  const maxJobIterations = config.maxJobIterations ?? MAX_JOB_ITERATIONS;

  const tools = toolMap([...defaultFileTools(), ...(config.tools ?? [])]);

  // ── Restore ──────────────────────────────────────────────────────────
  // First iteration: seed from the job input. Later iterations: rebuild from
  // the checkpoint the previous worker wrote. Either way, the FileStore is
  // seeded from checkpoint files: this is the fix for the classic
  // "agent forgot the files between steps" bug.
  let cp: LoopCheckpoint;
  const rawCp = job.checkpoint as Partial<LoopCheckpoint> | null;
  if (rawCp && Array.isArray(rawCp.systemMessages) && rawCp.systemMessages.length > 0) {
    cp = {
      systemMessages: rawCp.systemMessages,
      tailMessages: rawCp.tailMessages ?? [],
      round: rawCp.round ?? 0,
      consecutiveToolFailures: rawCp.consecutiveToolFailures ?? 0,
      readOnlyRounds: rawCp.readOnlyRounds ?? 0,
      guard: rawCp.guard ?? emptyGuard(),
      ...(rawCp.files ? { files: rawCp.files } : {}),
    };
  } else {
    const systemPrompt = buildSystemPrompt({
      purpose: config.purpose,
      extraInstructions: config.extraInstructions,
      tools: [...tools.values()],
    });
    cp = emptyCheckpoint(systemPrompt);
    const prompt = String((job.input as Record<string, unknown>).prompt ?? "");
    cp.tailMessages.push({ role: "user", content: prompt });
  }

  const messages: ChatMessage[] = restoreMessages(cp);
  const files = new FileStore(cp.files ?? []);
  const ctx: ToolContext = {
    jobId: job.id,
    userId: job.user_id,
    files,
    scratch: {},
  };

  // ── Bounded turns ────────────────────────────────────────────────────
  const allToolCalls: IterationOutcome["toolCalls"] = [];
  let done: string | null = null;
  let summary = "";

  for (let turn = 0; turn < maxTurns; turn++) {
    if (Date.now() > deadline) {
      summary = `Iteration deadline reached after ${turn} turns; checkpoint saved, continuing next iteration.`;
      break;
    }
    if ((cp.round ?? 0) >= maxJobIterations) {
      done = "Stopped: reached the maximum iteration budget for this job.";
      break;
    }

    const { message } = await llmComplete({
      messages,
      tools: [...tools.values()],
    });
    messages.push(message);
    cp.round += 1;

    const marker = parseDoneMarker(message.content);
    if (marker !== null) {
      done = marker;
      summary = `Completed: ${marker.slice(0, 200)}`;
      break;
    }

    if (message.tool_calls?.length) {
      const { records, stoppedReason } = await executeToolRound(
        messages,
        message.tool_calls,
        { tools, ctx, guard: cp.guard },
      );
      allToolCalls.push(...records);
      if (stoppedReason === "loop_detected") {
        summary = "Stopped turn: loop guard tripped on repeated tool calls.";
        break;
      }
      if (stoppedReason === "too_many_failures") {
        summary = "Stopped turn: too many consecutive tool failures.";
        break;
      }
    } else {
      // Model chatted without calling tools and without DONE: nudge it.
      cp.readOnlyRounds += 1;
      messages.push({
        role: "user",
        content:
          "Continue working with tools, or emit DONE: <summary> when the task is complete.",
      });
      if (cp.readOnlyRounds >= 3) {
        summary = "Stopped: model produced no tool calls for 3 consecutive turns.";
        break;
      }
    }
  }

  if (!done && !summary) {
    summary = `Iteration ${cp.round}: ${allToolCalls.length} tool call(s), continuing.`;
  }

  // ── Persist ──────────────────────────────────────────────────────────
  const nextCheckpoint = buildCheckpoint({
    messages,
    round: cp.round,
    consecutiveToolFailures: 0,
    readOnlyRounds: cp.readOnlyRounds,
    guard: cp.guard,
    files: files.entries(),
    ...(done ? { done: true, completion: done } : {}),
  });

  return {
    done: done !== null,
    ...(done ? { completion: done } : {}),
    summary,
    toolCalls: allToolCalls,
    checkpoint: nextCheckpoint,
  };
}
