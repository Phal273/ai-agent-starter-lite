/**
 * Runtime-portable env access.
 *
 * The agent core (lib/agent) is plain portable TypeScript: `process.env`
 * is the source in every runtime it runs in.
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
