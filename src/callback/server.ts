import * as http from "http";
import type { AddressInfo } from "net";
import type { DeliveryRequest } from "../types";
import type { ChannelRegistry } from "./channels";
import type { DeliveryContext } from "./channels/types";

export interface CallbackServerOptions {
  host: string;
  port: number;       // 0 = ephemeral
  token: string;      // required shared secret
  registry: ChannelRegistry;
  context: DeliveryContext;
  onError?: (err: Error) => void;
}

export interface CallbackServer {
  url(): string;
  port(): number;
  stop(): Promise<void>;
}

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB — plenty for a markdown payload

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body exceeds 1 MB limit"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function isValidDeliveryRequest(v: unknown): v is DeliveryRequest {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (typeof r.channel !== "string" || !r.channel) return false;
  const payload = r.payload;
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return typeof p.content === "string";
}

export async function startCallbackServer(
  opts: CallbackServerOptions
): Promise<CallbackServer> {
  if (!opts.token) throw new Error("callback server requires a token");

  const server = http.createServer(async (req, res) => {
    // Only the local callback endpoint is exposed. Everything else is 404.
    if (req.method === "GET" && req.url === "/health") {
      json(res, 200, { ok: true });
      return;
    }

    if (req.method !== "POST" || !req.url?.startsWith("/callback")) {
      json(res, 404, { error: "Not found" });
      return;
    }

    // Auth: Bearer header OR ?token= query param (for gateways that can't set headers).
    const authHeader = req.headers["authorization"];
    const bearer =
      typeof authHeader === "string" && authHeader.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length).trim()
        : "";
    const urlObj = new URL(req.url, "http://localhost");
    const queryToken = urlObj.searchParams.get("token") || "";
    const presented = bearer || queryToken;
    if (presented !== opts.token) {
      json(res, 401, { error: "Invalid or missing token" });
      return;
    }

    let bodyText: string;
    try {
      bodyText = await readBody(req);
    } catch (err) {
      json(res, 413, { error: err instanceof Error ? err.message : "Bad body" });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      json(res, 400, { error: "Invalid JSON" });
      return;
    }

    if (!isValidDeliveryRequest(parsed)) {
      json(res, 400, {
        error:
          "Expected { channel, sessionId?, target?, payload: { content, title?, metadata? } }",
      });
      return;
    }

    const channel = opts.registry.get(parsed.channel);
    if (!channel) {
      json(res, 400, {
        error: `Unknown channel "${parsed.channel}". Available: ${opts.registry
          .list()
          .map((c) => c.id)
          .join(", ")}`,
      });
      return;
    }

    try {
      await channel.deliver(opts.context, parsed);
      json(res, 200, { ok: true, channel: parsed.channel });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.onError?.(err instanceof Error ? err : new Error(msg));
      json(res, 500, { error: msg });
    }
  });

  server.on("error", (err) => opts.onError?.(err));

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(opts.port, opts.host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo | null;
  const boundPort = addr?.port ?? opts.port;

  return {
    url: () => `http://${opts.host}:${boundPort}`,
    port: () => boundPort,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
