/**
 * Minimal OpenAI-compatible chat client.
 *
 * One interface, two shapes: `complete()` for the agent loop (needs tool
 * calls back as structured data) and `stream()` for the chat UI (needs
 * tokens as they arrive). Point LLM_BASE_URL at OpenAI or any compatible
 * endpoint: the kit never assumes a specific vendor.
 */
import type { AgentTool, ChatMessage, LlmToolCall } from "./types.ts";
import { env, requireEnv } from "./env.ts";

function baseUrl(): string {
  return (env("LLM_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/$/, "");
}
function apiKey(): string {
  return requireEnv("LLM_API_KEY");
}
function model(): string {
  return env("LLM_MODEL") ?? "gpt-4o-mini";
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content ?? "" };
  if (m.name) out.name = m.name;
  if (m.tool_calls) {
    out.tool_calls = m.tool_calls.map((t) => ({
      id: t.id,
      type: "function",
      function: { name: t.name, arguments: t.arguments },
    }));
  }
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  return out;
}

function toWireTools(tools: AgentTool[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export interface CompletionResult {
  message: ChatMessage;
  finishReason: string;
}

async function postChat(
  body: Record<string, unknown>,
): Promise<Response> {
  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({ model: model(), ...body }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res;
}

/** Non-streaming completion for the agent loop. */
export async function complete(params: {
  messages: ChatMessage[];
  tools?: AgentTool[];
  temperature?: number;
  maxTokens?: number;
}): Promise<CompletionResult> {
  const res = await postChat({
    messages: params.messages.map(toWireMessage),
    ...(params.tools?.length ? { tools: toWireTools(params.tools) } : {}),
    temperature: params.temperature ?? 0.7,
    ...(params.maxTokens ? { max_tokens: params.maxTokens } : {}),
  });
  const data = (await res.json()) as {
    choices: Array<{
      finish_reason: string;
      message: {
        role: string;
        content: string | null;
        tool_calls?: Array<{
          id: string;
          function: { name: string; arguments: string };
        }>;
      };
    }>;
  };
  const choice = data.choices[0];
  const tool_calls: LlmToolCall[] | undefined = choice.message.tool_calls?.map(
    (t) => ({ id: t.id, name: t.function.name, arguments: t.function.arguments }),
  );
  return {
    message: {
      role: "assistant",
      content: choice.message.content,
      ...(tool_calls ? { tool_calls } : {}),
    },
    finishReason: choice.finish_reason,
  };
}

/**
 * Streaming completion for the chat UI. Yields SSE-formatted chunks
 * (`data: {...}\n\n`) that the client appends to the in-progress message.
 */
export async function* stream(params: {
  messages: ChatMessage[];
  tools?: AgentTool[];
  temperature?: number;
  signal?: AbortSignal;
}): AsyncGenerator<string, void, unknown> {
  const res = await postChat({
    messages: params.messages.map(toWireMessage),
    ...(params.tools?.length ? { tools: toWireTools(params.tools) } : {}),
    temperature: params.temperature ?? 0.7,
    stream: true,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") return;
      yield `data: ${payload}\n\n`;
    }
  }
}
