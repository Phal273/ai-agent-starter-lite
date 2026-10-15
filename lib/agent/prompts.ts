/**
 * System-prompt construction for the agent loop.
 *
 * Kept in its own module (not inlined in the worker) for one reason: the
 * prompt is the product. Buyers will rewrite this file first: tool
 * descriptions, the operating contract, the "done" protocol. Everything the
 * loop needs to behave is declared here as data, not buried in code.
 */
import type { AgentTool } from "./types.ts";

export interface PromptOptions {
  /** What the agent is for, in one paragraph. Sets the whole tone. */
  purpose: string;
  /** Extra domain instructions appended after the operating contract. */
  extraInstructions?: string;
  tools: AgentTool[];
}

const DONE_PROTOCOL = `When the task is fully complete, do NOT call more tools. Instead, end your
turn with your final answer as plain text, starting with the exact marker:

DONE: <your final summary>

The worker treats a turn beginning with "DONE:" as completion. If you are not
done, keep working: never emit the marker early.`;

const OPERATING_CONTRACT = `Operating contract:
- Work in small steps. Each turn, make progress with at most a few tool calls.
- Prefer reading before writing: inspect a file before editing it.
- If a tool call fails, read the error, adjust, and retry differently: do not
  repeat the identical call.
- Never invent file contents you have not read; never claim work you did not do.
- Keep responses concise. Narrate what you changed, not what you intend to do.`;

export function buildSystemPrompt(opts: PromptOptions): string {
  const toolDocs = opts.tools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n");

  return [
    `# Agent purpose\n${opts.purpose}`,
    `## Tools\n${toolDocs || "(no tools registered)"}`,
    `## ${OPERATING_CONTRACT}`,
    `## Completion protocol\n${DONE_PROTOCOL}`,
    opts.extraInstructions ? `## Notes\n${opts.extraInstructions}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Extract the completion text from a turn starting with the DONE marker. */
export function parseDoneMarker(text: string | null): string | null {
  if (!text) return null;
  const m = text.match(/^\s*DONE:\s*([\s\S]*)$/m);
  return m ? m[1].trim() : null;
}
