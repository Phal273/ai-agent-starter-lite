/**
 * Runtime-portable env access.
 *
 * The agent core (lib/agent) runs in TWO runtimes: Node.js (Next.js API
 * routes) and Deno (the Supabase Edge Function worker). `process.env` only
 * exists in the former, `Deno.env` only in the latter. This shim picks the
 * right one so the same modules run unmodified in both.
 */
export function env(name: string): string | undefined {
  const g = globalThis as unknown as {
    Deno?: { env?: { get(n: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  return g.Deno?.env?.get(name) ?? g.process?.env?.[name];
}

export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
