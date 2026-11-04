import { VtpassClient, type VtpassResponse } from "../client.js";

// Test-only. Excluded from the build.

export type Reply = VtpassResponse | "timeout" | "network" | { status: number; text: string };

/** A scripted VTpass: replies in order per path, and records every call. */
export function fakeVtpass(script: Record<string, Reply[]>) {
  const calls: { path: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace(/^\/api/, "");
    calls.push({
      path,
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const reply = script[path]?.shift();
    if (reply === undefined) throw new Error(`no scripted reply for ${path}`);
    if (reply === "timeout") throw Object.assign(new Error("t"), { name: "TimeoutError" });
    if (reply === "network") throw new TypeError("fetch failed");
    if ("status" in reply && "text" in reply) {
      return new Response(reply.text, { status: reply.status });
    }
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as typeof fetch;
  const client = new VtpassClient({
    baseUrl: "https://sandbox.vtpass.com/api",
    apiKey: "api",
    publicKey: "PK_pub",
    secretKey: "SK_sec",
    fetch: fetchFn,
  });
  return { client, calls };
}
