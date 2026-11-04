/**
 * Thin VTpass REST client. GET requests authenticate with api-key +
 * public-key, POST requests with api-key + secret-key.
 *
 * It returns VTpass's JSON as-is and throws VtpassTransportError when there
 * is no usable answer (timeout, network, non-JSON). It never decides what a
 * response means: outcome.ts does that.
 */

export interface VtpassConfig {
  baseUrl: string;
  apiKey: string;
  publicKey: string;
  secretKey: string;
  /** Per-request timeout for lookups. Default 15 s. */
  timeoutMs?: number;
  /** Timeout for `/pay`, which waits on the biller. Default 60 s. */
  payTimeoutMs?: number;
  fetch?: typeof fetch;
}

/** The fields we read. VTpass sends many more; they pass through untouched. */
export interface VtpassResponse {
  code?: string;
  response_description?: string;
  requestId?: string;
  amount?: number | string;
  transaction_date?: string | null;
  purchased_code?: string;
  token?: string;
  mainToken?: string;
  units?: string;
  content?: {
    transactions?: {
      status?: string;
      transactionId?: string;
      product_name?: string;
    };
    errors?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface Variation {
  variation_code: string;
  name: string;
  variation_amount: string;
  fixedPrice: string;
}

export interface ServiceInfo {
  serviceID: string;
  name: string;
  minimium_amount: string;
  maximum_amount: string;
  product_type: string;
}

export interface PayRequest {
  request_id: string;
  serviceID: string;
  billersCode?: string;
  variation_code?: string;
  amount?: number;
  phone: string;
  subscription_type?: "change" | "renew";
  quantity?: number;
}

export type TransportFailure = "timeout" | "network" | "http" | "bad_json";

export class VtpassTransportError extends Error {
  constructor(
    readonly reason: TransportFailure,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "VtpassTransportError";
  }
}

export class VtpassClient {
  private readonly base: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly cfg: VtpassConfig) {
    this.base = cfg.baseUrl.replace(/\/+$/, "");
    this.fetch = cfg.fetch ?? globalThis.fetch;
  }

  get isSandbox(): boolean {
    return this.base.includes("sandbox");
  }

  balance(): Promise<VtpassResponse> {
    return this.get("/balance");
  }

  async services(identifier: string): Promise<ServiceInfo[]> {
    const res = await this.get(`/services?identifier=${encodeURIComponent(identifier)}`);
    return Array.isArray(res.content) ? (res.content as ServiceInfo[]) : [];
  }

  async variations(serviceId: string): Promise<Variation[]> {
    const res = await this.get(`/service-variations?serviceID=${encodeURIComponent(serviceId)}`);
    const list = res.content?.variations;
    return Array.isArray(list) ? (list as Variation[]) : [];
  }

  /** Meter (electricity, with `type`) or smartcard (TV) lookup. */
  verify(input: {
    serviceID: string;
    billersCode: string;
    type?: string;
  }): Promise<VtpassResponse> {
    return this.post("/merchant-verify", input);
  }

  pay(req: PayRequest): Promise<VtpassResponse> {
    return this.post("/pay", req, this.cfg.payTimeoutMs ?? 60_000);
  }

  requery(requestId: string): Promise<VtpassResponse> {
    return this.post("/requery", { request_id: requestId });
  }

  private get(path: string): Promise<VtpassResponse> {
    return this.send(path, {
      method: "GET",
      headers: { "api-key": this.cfg.apiKey, "public-key": this.cfg.publicKey },
    });
  }

  private post(path: string, body: object, timeoutMs?: number): Promise<VtpassResponse> {
    return this.send(
      path,
      {
        method: "POST",
        headers: {
          "api-key": this.cfg.apiKey,
          "secret-key": this.cfg.secretKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
  }

  private async send(path: string, init: RequestInit, timeoutMs?: number): Promise<VtpassResponse> {
    let res: Response;
    try {
      res = await this.fetch(`${this.base}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs ?? this.cfg.timeoutMs ?? 15_000),
      });
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new VtpassTransportError("timeout", `VTpass ${path} timed out`);
      }
      throw new VtpassTransportError("network", `VTpass ${path} unreachable: ${String(e)}`);
    }
    const text = await res.text().catch(() => "");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new VtpassTransportError(
        res.ok ? "bad_json" : "http",
        `VTpass ${path} returned HTTP ${res.status} without JSON`,
        res.status,
      );
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      throw new VtpassTransportError("bad_json", `VTpass ${path} returned non-object JSON`);
    }
    // VTpass puts its verdict in `code`, even on HTTP 4xx. Only a 5xx with
    // no code is a transport problem.
    const body = json as VtpassResponse;
    if (res.status >= 500 && body.code === undefined) {
      throw new VtpassTransportError(
        "http",
        `VTpass ${path} returned HTTP ${res.status}`,
        res.status,
      );
    }
    return body;
  }
}
