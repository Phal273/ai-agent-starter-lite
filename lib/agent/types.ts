/**
 * Shared types for the iteration-based agent loop.
 *
 * The central idea: an agent run is NOT one long request. It is a job row in
 * Postgres, advanced one short iteration at a time. Each iteration is
 * bounded (< 30s), writes its checkpoint back to the job row, and returns.
 * Any worker can run the next iteration: crashes cost one step, never the run.
 */

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface AgentJob {
  id: string;
  user_id: string;
  status: JobStatus;
  /** Immutable task description: { prompt, kind, maxIterations?, … } */
  input: Record<string, unknown>;
  /** Final output, written once on completion. */
  result: Record<string, unknown> | null;
  /** Resumable loop state: see checkpoint.ts. */
  checkpoint: LoopCheckpoint;
  attempts: number;
  last_error: string | null;
  heartbeat_at: string;
  created_at: string;
  updated_at: string;
}

export interface AgentIteration {
  id: string;
  job_id: string;
  seq: number;
  summary: string | null;
  tool_calls: ToolCallRecord[];
  duration_ms: number;
  created_at: string;
}

/** The serializable loop state stored on the job row after every iteration. */
export interface LoopCheckpoint {
  /** Opening system messages (base prompt, plan): preserved verbatim. */
  systemMessages: ChatMessage[];
  /** Rolling tail of recent non-system messages (bounded, e.g. last 30). */
  tailMessages: ChatMessage[];
  round: number;
  consecutiveToolFailures: number;
  readOnlyRounds: number;
  /** Serialized loop-guard counters (dedup, failure tracking). */
  guard: LoopGuardState;
  /** Accumulated file state, serialized (see filestore.ts). */
  files?: Array<{ path: string; content: string }>;
  /** Set when the loop has produced its final answer. */
  done?: boolean;
  /** Final answer text, when done. */
  completion?: string;
}

export interface LoopGuardState {
  /** tool-call signature → times seen (loop detection). */
  seenToolCalls: Record<string, number>;
  /** file path → no-op edit attempts (gives up after N). */
  noopMutations: Record<string, number>;
  /** tool names that errored as unavailable. */
  unavailableTools: string[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
}

/** A tool call as returned by the model. */
export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string; // JSON-encoded
}

/** A tool call + its result, recorded per iteration. */
export interface ToolCallRecord extends LlmToolCall {
  result: string;
  durationMs: number;
  ok: boolean;
}

/** A tool the agent can call. Handlers run server-side, inside the worker. */
export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<ToolResult>;
}

export interface ToolContext {
  jobId: string;
  userId: string;
  files: import("./filestore.ts").FileStore;
  /** Scratch space the loop persists across iterations via the checkpoint. */
  scratch: Record<string, unknown>;
}

export type ToolResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

/** Outcome of one iteration step. */
export interface IterationOutcome {
  done: boolean;
  completion?: string;
  summary: string;
  toolCalls: ToolCallRecord[];
  checkpoint: LoopCheckpoint;
}
