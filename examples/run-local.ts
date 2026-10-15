/**
 * Local driver for the iteration-based agent loop: no database required.
 *
 * This is the whole pattern in one file:
 *   1. load the checkpoint from disk (or start fresh),
 *   2. run ONE bounded iteration (< 25s),
 *   3. write the checkpoint back to disk,
 *   4. repeat until DONE.
 *
 * Try it: run `npm run -- "Write a haiku about databases, save it to haiku.txt"`,
 * then hit Ctrl-C mid-run and run it again. The agent resumes exactly where
 * it stopped: files, conversation, and guard state intact. That's the entire
 * point of the iteration loop.
 *
 * Setup:
 *   npm install
 *   cp .env.example .env   # then add your LLM key
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { runIteration, type LoopConfig } from "../lib/agent/loop.ts";
import type { AgentJob } from "../lib/agent/types.ts";

const CHECKPOINT_PATH = new URL("../checkpoint.json", import.meta.url);

const task =
  process.argv.slice(2).join(" ") ||
  "Create a file called plan.txt containing a 3-step plan for learning TypeScript.";

function loadCheckpoint(): Record<string, unknown> | null {
  if (!existsSync(CHECKPOINT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CHECKPOINT_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveCheckpoint(cp: unknown): void {
  writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
}

async function main(): Promise<void> {
  const existing = loadCheckpoint();
  if (existing) {
    console.log("▶ Resuming from saved checkpoint (round %s).", (existing as { round?: number }).round ?? 0);
  } else {
    console.log("▶ Starting new job.");
  }

  const job: AgentJob = {
    id: "local-job-1",
    user_id: "local-user",
    status: "running",
    input: { prompt: task },
    result: null,
    // The checkpoint IS the job state. Fresh run → null; resume → the blob.
    checkpoint: (existing ?? null) as unknown as AgentJob["checkpoint"],
    attempts: 0,
    last_error: null,
    heartbeat_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const config: LoopConfig = {
    purpose:
      "You are a helpful coding assistant working in a virtual project workspace. " +
      "Use the file tools to read, write, and edit files to complete the task.",
  };

  const MAX_ITERATIONS = 20;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const t0 = Date.now();
    const outcome = await runIteration(job, config);
    // Persist BEFORE checking done: a crash right here must not lose the step.
    saveCheckpoint(outcome.checkpoint);
    job.checkpoint = outcome.checkpoint;

    console.log(
      `\n── iteration ${i + 1} (${Date.now() - t0}ms) ──\n${outcome.summary}`,
    );
    if (outcome.toolCalls.length > 0) {
      for (const tc of outcome.toolCalls) {
        console.log(`  ${tc.ok ? "✓" : "✗"} ${tc.name} (${tc.durationMs}ms)`);
      }
    }

    if (outcome.done) {
      console.log("\n✅ DONE:\n" + (outcome.completion ?? "(no summary)"));
      // Clean up so the next run starts fresh.
      try {
        unlinkSync(CHECKPOINT_PATH);
      } catch { /* already gone */ }
      return;
    }
  }
  console.log("\n⏸ Hit the iteration cap. Run again to continue. Nothing is lost.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
