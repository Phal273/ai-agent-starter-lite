# AI Agent Starter: Lite

The crash-safe **iteration-based agent loop** + **FileStore**, as a standalone
package. No database, no framework, no signup. Just the core pattern,
runnable in one file.

This is the free companion to the **[AI Agent Product Starter Kit](https://phal273.github.io/unbroken/)**
: the full production kit (Next.js app, streaming chat UI, RAG over pgvector,
Postgres job queue, Stripe subscriptions). Everything here also ships in the
paid version; the paid version adds everything around it.

## The pattern in 60 seconds

Most agent tutorials run the whole loop in **one long request**. That dies on
timeouts, loses everything on a crash, and can't be observed mid-run.

The iteration loop decomposes the run into **single short steps**, each
persisted before the next begins:

```
enqueue → [ restore checkpoint → iterate (<25s) → save checkpoint ] × N → DONE
```

- **Bounded iterations** (`lib/agent/loop.ts`): max 4 model turns or 25s wall-clock per step. The loop exits early; the checkpoint carries the run forward.
- **Checkpoints** (`lib/agent/checkpoint.ts`): after every iteration, the *entire* loop context: system prompt, rolling 30-message tail, round/guard counters: is serialized to one JSON blob. Any worker can resume from it. A crash costs one step, never the run.
- **FileStore** (`lib/agent/filestore.ts`): the agent's working filesystem, seeded from the checkpoint at the start of every iteration and serialized back at the end. This kills the classic "my agent forgot the files between steps" bug. Paths are normalized so the model can't escape the project.
- **Tool rounds with guardrails** (`lib/agent/tools.ts`): loop detection (same tool + args 3× → stop), failure budgets, and "unavailable tool" memory persisted in the checkpoint so a resumed loop doesn't retry dead tools forever.
- **Default file tools** (`lib/agent/default-tools.ts`): list, read, write, edit: the minimum viable toolset. Add your own domain tools via `LoopConfig`.

## Run it

```bash
npm install
cp .env.example .env   # add any OpenAI-compatible LLM key
npm run -- "Write a haiku about databases, save it to haiku.txt"
```

The checkpoint is saved to `checkpoint.json` after **every** iteration:
before checking for completion. Hit **Ctrl-C mid-run** and run it again: the
agent resumes exactly where it stopped, files and conversation intact.

## What's here vs. the full kit

| | Lite (this repo) | Full kit |
|---|---|---|
| Iteration loop + checkpoints | ✅ | ✅ |
| FileStore | ✅ | ✅ |
| Tool rounds + guardrails | ✅ | ✅ |
| File tools (list/read/write/edit) | ✅ | ✅ |
| Local JSON checkpointing | ✅ |: |
| Postgres queue (`SKIP LOCKED` claims, heartbeats) |: | ✅ |
| Deno edge-function worker |: | ✅ |
| Streaming chat UI (SSE) |: | ✅ |
| RAG (pgvector `match_documents`) |: | ✅ |
| Auth (Supabase + RLS) |: | ✅ |
| Stripe subscriptions + webhooks |: | ✅ |
| Architecture deep-dive docs |: | ✅ |

## Files

```
lib/agent/
  loop.ts          The iteration driver (the heart of it)
  checkpoint.ts    Serialize / restore loop state
  filestore.ts     The agent's persistent working filesystem
  tools.ts         Tool registry + guarded round executor
  default-tools.ts list_files, read_file, write_file, edit_file
  prompts.ts       System-prompt builder + DONE protocol
  llm.ts           Minimal OpenAI-compatible client
  types.ts         Shared types
  env.ts           Runtime-portable env (Node + Deno)
examples/
  run-local.ts     Local driver: JSON checkpointing, Ctrl-C-safe resume
```

## License

MIT: use it in anything, including commercial products.
