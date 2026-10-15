/**
 * Default file tools, wired to the iteration's FileStore.
 *
 * These four tools are the minimum viable toolset for any agent that builds
 * or edits things: list, read, write, edit. Register them always; add your
 * domain tools (web search, database, API calls) alongside via LoopConfig.
 */
import type { AgentTool } from "./types.ts";

export function defaultFileTools(): AgentTool[] {
  const listFiles: AgentTool = {
    name: "list_files",
    description: "List all file paths in the project workspace.",
    parameters: { type: "object", properties: {} },
    handler: async (_args, ctx) => ({
      ok: true,
      output: ctx.files.list().join("\n") || "(no files yet)",
    }),
  };

  const readFile: AgentTool = {
    name: "read_file",
    description: "Read the full content of a file. Read before editing.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Project-relative path" } },
      required: ["path"],
    },
    handler: async (args, ctx) => {
      const content = ctx.files.get(String(args.path));
      return content === null
        ? { ok: false, error: `File not found: ${args.path}` }
        : { ok: true, output: content };
    },
  };

  const writeFile: AgentTool = {
    name: "write_file",
    description:
      "Create or overwrite a file with the given content. Prefer edit_file for small changes to existing files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project-relative path" },
        content: { type: "string", description: "Full file content" },
      },
      required: ["path", "content"],
    },
    handler: async (args, ctx) => {
      try {
        ctx.files.set(String(args.path), String(args.content ?? ""));
        return { ok: true, output: `Wrote ${args.path}` };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const editFile: AgentTool = {
    name: "edit_file",
    description:
      "Replace a block of text in a file (matched line-by-line, whitespace-tolerant). Fails when the search text is not found.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project-relative path" },
        search: { type: "string", description: "Exact block to replace" },
        replace: { type: "string", description: "Replacement block" },
      },
      required: ["path", "search", "replace"],
    },
    handler: async (args, ctx) => {
      const r = ctx.files.edit(
        String(args.path),
        String(args.search ?? ""),
        String(args.replace ?? ""),
      );
      return r.ok
        ? { ok: true, output: `Edited ${args.path}` }
        : { ok: false, error: r.error ?? "edit failed" };
    },
  };

  return [listFiles, readFile, writeFile, editFile];
}
