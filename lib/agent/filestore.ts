/**
 * FileStore: the agent's working filesystem, held in memory and persisted
 * through the job checkpoint between iterations.
 *
 * Why this exists: in an iteration-based loop, each step may run in a fresh
 * process (or after a crash). If files only lived in memory, step N+1 would
 * forget everything step N wrote. The worker seeds a FileStore from the
 * checkpoint at the start of every iteration and serializes it back at the
 * end: file persistence becomes a non-issue, and the #1 "my agent forgot
 * the files" bug class disappears.
 *
 * Path handling: all paths are normalized (forward slashes, no leading
 * slash, no `..` escapes) so the model can't wander outside the project.
 */

export interface ProjectFile {
  path: string;
  content: string;
}

/** Normalize a user/model-supplied path. Returns null when unsafe. */
export function normalizePath(path: string): string | null {
  const cleaned = path.replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  const parts = cleaned.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) return null; // escape attempt
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.length > 0 ? stack.join("/") : null;
}

export class FileStore {
  private files = new Map<string, string>();
  private deletedPaths = new Set<string>();

  constructor(existing: ProjectFile[] = []) {
    for (const f of existing) {
      const p = normalizePath(f.path);
      if (p) this.files.set(p, f.content);
    }
  }

  list(): string[] {
    return [...this.files.keys()].sort();
  }

  get(path: string): string | null {
    const p = normalizePath(path);
    return p ? (this.files.get(p) ?? null) : null;
  }

  has(path: string): boolean {
    const p = normalizePath(path);
    return p ? this.files.has(p) : false;
  }

  set(path: string, content: string): void {
    const p = normalizePath(path);
    if (!p) throw new Error(`Unsafe path rejected: ${path}`);
    this.files.set(p, content);
    this.deletedPaths.delete(p);
  }

  delete(path: string): boolean {
    const p = normalizePath(path);
    if (!p) return false;
    const existed = this.files.delete(p);
    this.deletedPaths.add(p);
    return existed;
  }

  wasDeleted(path: string): boolean {
    const p = normalizePath(path);
    return p ? this.deletedPaths.has(p) : false;
  }

  entries(): ProjectFile[] {
    return [...this.files.entries()].map(([path, content]) => ({
      path,
      content,
    }));
  }

  size(): number {
    return this.files.size;
  }

  isEmpty(): boolean {
    if (this.files.size === 0) return true;
    for (const content of this.files.values()) {
      if (content.trim().length > 0) return false;
    }
    return true;
  }

  /**
   * Line-based search & replace. Matches on trimmed lines, so the model's
   * slightly-off memory of a file's indentation still resolves: this one
   * detail eliminates a huge fraction of "edit failed" tool errors.
   */
  edit(
    path: string,
    search: string,
    replace: string,
  ): { ok: boolean; error?: string } {
    const p = normalizePath(path);
    if (!p) return { ok: false, error: `Unsafe path: ${path}` };
    const current = this.files.get(p);
    if (current === undefined)
      return { ok: false, error: `File not found: ${path}` };
    if (!search.trim())
      return { ok: false, error: "edit requires a non-empty search string" };

    const lines = current.split("\n");
    const searchLines = search.split("\n").map((s) => s.trim());
    for (let i = 0; i <= lines.length - searchLines.length; i++) {
      if (lines[i].trim() !== searchLines[0]) continue;
      let match = true;
      for (let j = 1; j < searchLines.length; j++) {
        if (lines[i + j].trim() !== searchLines[j]) {
          match = false;
          break;
        }
      }
      if (!match) continue;
      const next =
        lines.slice(0, i).join("\n") +
        (i > 0 ? "\n" : "") +
        replace +
        (i + searchLines.length < lines.length ? "\n" : "") +
        lines.slice(i + searchLines.length).join("\n");
      this.files.set(p, next);
      return { ok: true };
    }
    return { ok: false, error: `Search text not found in ${path}` };
  }

  /** Case-insensitive substring search across all file contents. */
  search(
    query: string,
    limit = 10,
  ): Array<{ path: string; line: number; snippet: string }> {
    if (!query) return [];
    const q = query.toLowerCase();
    const results: Array<{ path: string; line: number; snippet: string }> = [];
    for (const [path, content] of this.files.entries()) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && results.length < limit; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          results.push({
            path,
            line: i + 1,
            snippet: lines[i].trim().slice(0, 200),
          });
        }
      }
      if (results.length >= limit) break;
    }
    return results;
  }
}

/**
 * Serialize files into fenced blocks for checkpoint persistence.
 * Format: ```path:<path>\n<content>\n```: simple, grep-able, model-friendly.
 */
export function serializeFiles(files: ProjectFile[]): string {
  return files
    .map((f) => "```path:" + f.path + "\n" + f.content + "\n```")
    .join("\n\n");
}

export function parseFencedFiles(source: string | null | undefined): ProjectFile[] {
  if (!source) return [];
  const out: ProjectFile[] = [];
  const re = /```path:([^\n]+)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const p = normalizePath(m[1].trim());
    // serializeFiles() appends exactly one "\n" before the closing fence:
    // strip it so the round-trip is byte-exact.
    if (p) out.push({ path: p, content: m[2].replace(/\n$/, "") });
  }
  return out;
}
