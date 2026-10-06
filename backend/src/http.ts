/**
 * Minimal HTTP helpers: JSON body parsing with a size cap, JSON responses,
 * bearer auth, and per-request metadata logging (never bodies).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { logger } from "../../shared/logger.js";

export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export function setCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers["origin"];
  // Loopback dev gateway: allow extension + local pages. Reflect origin when
  // present (chrome-extension://, http://127.0.0.1), else wildcard.
  res.setHeader(
    "Access-Control-Allow-Origin",
    typeof origin === "string" && origin !== "" ? origin : "*",
  );
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  // Echo requested headers so preflights (incl. Chrome's private-network
  // probe) always pass, and declare private-network access explicitly.
  const requested = req.headers["access-control-request-headers"];
  res.setHeader(
    "Access-Control-Allow-Headers",
    typeof requested === "string" && requested !== ""
      ? requested
      : "Content-Type, Authorization",
  );
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Max-Age", "86400");
}

export function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

/** Reads + parses a JSON body. Throws {status, code} shaped errors. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw { status: 413, code: "PAYLOAD_TOO_LARGE" };
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") {
    throw { status: 400, code: "EMPTY_BODY" };
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw { status: 400, code: "MALFORMED_JSON" };
  }
}

/** Bearer check against the configured token. Open when no token configured. */
export function checkAuth(req: IncomingMessage, configuredToken: string): boolean {
  if (configuredToken === "") return true;
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(configuredToken);
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

export type RequestMeta = {
  method: string;
  path: string;
  status: number;
  ms: number;
};

export function logRequest(meta: RequestMeta): void {
  logger.info("http", meta);
}
