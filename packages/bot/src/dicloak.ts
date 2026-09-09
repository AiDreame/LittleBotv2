/**
 * DICloak Local Open API client — payout-check MVP only.
 *
 * Verified against the DICloak "Local Open API Guide"
 * (https://help.dicloak.com/api-development-guide):
 *   - Base URL: http://127.0.0.1:52140/openapi  ("/openapi" suffix required)
 *   - Auth: request header `X-API-KEY` with the key from More > Settings > Open API
 *   - GET {base}/v1/env/list with query params page_no / page_size (sample code)
 *   - PATCH {base}/v1/env/{env_id}/open  → data { serial_number, pid, debug_port }
 *   - PATCH {base}/v1/env/{env_id}/close
 *   - Browser control: GET http://127.0.0.1:{debug_port}/json/version →
 *     webSocketDebuggerUrl, then drive via CDP (Playwright/puppeteer in guide;
 *     this MVP speaks raw CDP over the global WebSocket — zero new deps).
 *   - Success envelope: HTTP 200 + JSON { code: 0, msg, data }.
 *
 * Owner constraints honored here:
 *   - every API parameter is a string (non-strings are rejected, not coerced)
 *   - POST/PATCH bodies (when present) are JSON
 *   - max one DICloak request/second globally (waitForDicloakSlot)
 *   - the API key is read from DICLOAK_API_KEY only at send time, is never
 *     part of any built request object, and is never logged.
 */

export const DICLOAK_API_BASE = "http://127.0.0.1:52140/openapi";

/** The one and only page this MVP ever navigates a profile browser to. */
export const MALOUM_PAYOUT_URL = "https://app.maloum.com/payout";

/** Minimum gap between DICloak Local API calls (owner: max 1 request/second). */
export const DICLOAK_MIN_INTERVAL_MS = 1100;

let lastDicloakCallAt = 0;

/** Test hook: reset the global rate-limiter clock. */
export function resetDicloakRateLimiterForTest(): void {
  lastDicloakCallAt = 0;
}

/**
 * Wait until a DICloak API call slot is free, then claim it.
 * Every DICloak Local API request must go through this first.
 */
export async function waitForDicloakSlot(): Promise<void> {
  const wait = DICLOAK_MIN_INTERVAL_MS - (Date.now() - lastDicloakCallAt);
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastDicloakCallAt = Date.now();
}

export type BuiltDicloakRequest = {
  url: string;
  method: "GET" | "PATCH";
  /** Deliberately no auth header here — the key is attached only in dicloakSend. */
  headers: Record<string, string>;
};

function requireStringParam(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      `DICloak param "${name}" must be a non-empty string`,
    );
  }
  return value;
}

/**
 * GET /v1/env/list?page_no=&page_size= — params stay strings in the query,
 * matching the guide's sample code.
 */
export function buildListEnvsRequest(
  pageNo: unknown,
  pageSize: unknown,
): BuiltDicloakRequest {
  const page_no = requireStringParam("page_no", pageNo);
  const page_size = requireStringParam("page_size", pageSize);
  return {
    url:
      `${DICLOAK_API_BASE}/v1/env/list?page_no=${encodeURIComponent(page_no)}` +
      `&page_size=${encodeURIComponent(page_size)}`,
    method: "GET",
    headers: {},
  };
}

/** PATCH /v1/env/{env_id}/open — no body (per guide sample). */
export function buildOpenEnvRequest(envId: unknown): BuiltDicloakRequest {
  const id = requireStringParam("env_id", envId);
  return {
    url: `${DICLOAK_API_BASE}/v1/env/${encodeURIComponent(id)}/open`,
    method: "PATCH",
    headers: {},
  };
}

/** PATCH /v1/env/{env_id}/close — no body (per guide sample). */
export function buildCloseEnvRequest(envId: unknown): BuiltDicloakRequest {
  const id = requireStringParam("env_id", envId);
  return {
    url: `${DICLOAK_API_BASE}/v1/env/${encodeURIComponent(id)}/close`,
    method: "PATCH",
    headers: {},
  };
}

export type DicloakEnvelope = {
  code: number;
  msg: string;
  data?: unknown;
};

function requireApiKey(): string {
  const key = process.env.DICLOAK_API_KEY;
  if (!key) {
    throw new Error(
      "DICLOAK_API_KEY is not set — configure it in the bot environment, then retry.",
    );
  }
  return key;
}

/**
 * Send one rate-limited DICloak request. The key travels only in the
 * X-API-KEY header and is never written to logs (callers must log status
 * codes / msg only).
 */
export async function dicloakSend(
  req: BuiltDicloakRequest,
  jsonBody?: unknown,
): Promise<DicloakEnvelope> {
  await waitForDicloakSlot();
  const key = requireApiKey();
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers: {
        ...req.headers,
        "X-API-KEY": key,
        "Content-Type": "application/json",
      },
      body: jsonBody === undefined ? undefined : JSON.stringify(jsonBody),
    });
  } catch (err) {
    throw new Error(
      `DICloak request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`DICloak HTTP ${res.status} on ${req.method} ${urlPathOf(req.url)}`);
  }
  const envelope = (await res.json()) as DicloakEnvelope;
  return envelope;
}

/** Assert a guide-style success envelope; returns data or throws (msg only). */
export function assertDicloakOk(envelope: DicloakEnvelope, action: string): unknown {
  if (envelope.code !== 0) {
    throw new Error(`DICloak ${action} failed: ${envelope.msg || `code ${envelope.code}`}`);
  }
  return envelope.data;
}

function urlPathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "(unparseable-url)";
  }
}

// ── Browser snapshot over raw CDP (no new dependencies) ──

export type PageSnapshot = {
  finalUrl: string;
  title: string;
  /** Visible text, truncated — used only for conservative login/payout signals. */
  bodyText: string;
};

type MinimalWs = {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

/**
 * Resolve the CDP websocket URL for an opened profile via the Chromium
 * devtools HTTP endpoint the guide points at (http://127.0.0.1:{port}/json/version).
 * No API key involved; the port comes from DICloak's open response.
 */
export async function getCdpWebSocketUrl(debugPort: unknown): Promise<string> {
  const port = requireStringParam("debug_port", debugPort);
  if (!/^\d+$/.test(port)) {
    throw new Error("DICloak returned an invalid debug_port");
  }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/json/version`);
  } catch (err) {
    throw new Error(
      `CDP version endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`CDP version endpoint HTTP ${res.status}`);
  }
  const info = (await res.json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof info.webSocketDebuggerUrl !== "string" || !info.webSocketDebuggerUrl) {
    throw new Error("CDP version endpoint returned no webSocketDebuggerUrl");
  }
  return info.webSocketDebuggerUrl;
}

/**
 * Navigate the already-open profile browser to `targetUrl` and snapshot the
 * settled page (final URL, title, visible text). Read-only: no clicks, no
 * form fills, no credential entry, no CAPTCHA interaction.
 */
export async function snapshotPageOverCdp(
  wsDebuggerUrl: string,
  targetUrl: string,
  timeoutMs = 45000,
): Promise<PageSnapshot> {
  const WS = (
    globalThis as unknown as { WebSocket?: new (url: string) => MinimalWs }
  ).WebSocket;
  if (!WS) {
    throw new Error("global WebSocket is unavailable (Node >= 22 required)");
  }
  return new Promise<PageSnapshot>((resolve, reject) => {
    let settled = false;
    let finishing = false;
    const ws: MinimalWs = new WS(wsDebuggerUrl);
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      fn();
    };
    const fail = (message: string): void => {
      done(() => reject(new Error(message)));
    };

    let id = 0;
    const pending = new Map<number, (err: string | null, result?: unknown) => void>();
    const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
      new Promise((res, rej) => {
        id += 1;
        const cur = id;
        pending.set(cur, (err, result) => {
          if (err) rej(new Error(`CDP ${method}: ${err}`));
          else res(result);
        });
        try {
          ws.send(JSON.stringify({ id: cur, method, params }));
        } catch (err) {
          pending.delete(cur);
          rej(err instanceof Error ? err : new Error(String(err)));
        }
      });

    const finish = (): void => {
      if (finishing || settled) return;
      finishing = true;
      void (async () => {
        try {
          await send("Page.enable");
          const evalRes = (await send("Runtime.evaluate", {
            expression:
              "({url: location.href, title: document.title, text: (document.body ? document.body.innerText : '')})",
            returnByValue: true,
          })) as { result?: { value?: { url?: unknown; title?: unknown; text?: unknown } } };
          const value = evalRes?.result?.value ?? {};
          const snapshot: PageSnapshot = {
            finalUrl: typeof value.url === "string" ? value.url : targetUrl,
            title: typeof value.title === "string" ? value.title : "",
            bodyText:
              typeof value.text === "string" ? (value.text as string).slice(0, 8000) : "",
          };
          done(() => resolve(snapshot));
        } catch (err) {
          fail(`CDP snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    };

    const timer = setTimeout(finish, timeoutMs);

    ws.onmessage = (ev: unknown): void => {
      let msg: { id?: number; result?: unknown; error?: { message?: unknown }; method?: string };
      try {
        msg = JSON.parse(String((ev as { data?: unknown }).data)) as typeof msg;
      } catch {
        return;
      }
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        const cb = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) cb(String(msg.error.message ?? "unknown error"));
        else cb(null, msg.result);
        return;
      }
      if (msg.method === "Page.loadEventFired") finish();
    };
    ws.onerror = (): void => {
      fail("CDP connection failed (is the DICloak profile browser still open?)");
    };
    ws.onopen = (): void => {
      void (async () => {
        try {
          await send("Page.enable");
          await send("Page.navigate", { url: targetUrl });
        } catch (err) {
          fail(`CDP navigate failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    };
  });
}
