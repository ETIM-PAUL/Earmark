/**
 * NEAR AI Cloud, through its OpenAI-compatible chat API. JSON-object mode
 * only: the strict json_schema mode is refused by the default DeepSeek model,
 * so the schema is enforced in code (extract.ts) instead.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatModel {
  /** Returns the model's raw reply, expected to be one JSON object. */
  json(messages: ChatMessage[]): Promise<string>;
}

export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelError";
  }
}

export interface NearAiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class NearAiModel implements ChatModel {
  constructor(private readonly cfg: NearAiConfig) {}

  async json(messages: ChatMessage[]): Promise<string> {
    const f = this.cfg.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.cfg.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.cfg.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages,
        }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
      });
    } catch (e) {
      throw new ModelError(`NEAR AI unreachable: ${(e as Error).name}`);
    }
    const body = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    } | null;
    const content = body?.choices?.[0]?.message?.content;
    if (!res.ok || typeof content !== "string") {
      throw new ModelError(`NEAR AI HTTP ${res.status}: ${body?.error?.message ?? "no content"}`);
    }
    return content;
  }
}
