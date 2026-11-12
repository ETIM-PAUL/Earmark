// The sender app's client for the bot's /api. A session token from a
// passkey sign-in rides in the Authorization header.

export const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:4003").replace(
  /\/+$/,
  "",
);
const KEY = "earmark.session";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message);
  }
}

// Storage can throw (private windows, blocked site data): never depend on it.
export const session = {
  get(): string | null {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set(token: string | null): void {
    try {
      if (token) localStorage.setItem(KEY, token);
      else localStorage.removeItem(KEY);
    } catch {
      // the session lasts until the page closes
    }
    memory = token;
  },
};
let memory: string | null = null;
const token = () => memory ?? session.get();

export async function api<T>(
  path: string,
  opts: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T> {
  const t = token();
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers: {
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        ...(t ? { authorization: `Bearer ${t}` } : {}),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
  } catch {
    throw new ApiError("We can't reach Earmark right now. Please check your connection.", 0);
  }
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new ApiError(
      typeof json.error === "string" ? json.error : "That didn't work. Please try again.",
      res.status,
      typeof json.reason === "string" ? json.reason : undefined,
    );
  }
  return json as T;
}
