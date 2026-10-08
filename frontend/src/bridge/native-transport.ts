/**
 * Native-messaging transport for the Browser Harness bridge — REAL.
 *
 * Talks to the external harness host (`com.inviz.harness`, a Python sidecar
 * built on browser-use/browser-harness) over chrome.runtime.connectNative.
 * This module opens NO sockets, evaluates NO JavaScript, touches NO CDP and
 * spawns NO processes — the host process owns all of that outside MV3 (the
 * transport is injected and owned by the host side of the boundary).
 *
 * One bounded request per send(): requestId-matched reply or timeout/
 * disconnect, both surfacing as transport errors so the controller falls
 * back to local execution. Never throws synchronously.
 */
import { BRIDGE_TIMEOUT_MS, MAX_BRIDGE_MESSAGE_BYTES } from "../../../shared/execution.js";
import type { BridgeRequest } from "../../../shared/bridge-protocol.js";
import type { BridgeTransport } from "./harness-bridge.js";

export const INVIZ_HARNESS_HOST = "com.inviz.harness";

interface NativePortEvents {
  addListener(callback: (message: unknown) => void): void;
  removeListener?(callback: (message: unknown) => void): void;
}

interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: NativePortEvents;
  onDisconnect: NativePortEvents;
}

interface ChromeRuntimeShape {
  connectNative(hostName: string): NativePort;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function chromeRuntime(): ChromeRuntimeShape | null {
  const candidate = (globalThis as unknown as { chrome?: { runtime?: unknown } }).chrome;
  const runtime = candidate?.runtime as { connectNative?: unknown } | undefined;
  if (typeof runtime?.connectNative !== "function") return null;
  return runtime as unknown as ChromeRuntimeShape;
}

/**
 * Sends one bridge request to the native host and resolves with the raw
 * reply (validated downstream by validateBridgeResponse). Rejects on
 * connect failure, disconnect, timeout, or oversize — all meaning
 * "run locally instead".
 */
export class NativeMessagingTransport implements BridgeTransport {
  private readonly hostName: string;
  private readonly timeoutMs: number;

  constructor(hostName: string = INVIZ_HARNESS_HOST, timeoutMs: number = BRIDGE_TIMEOUT_MS) {
    this.hostName = hostName;
    this.timeoutMs = timeoutMs;
  }

  send(request: BridgeRequest): Promise<unknown> {
    let payload: string;
    try {
      payload = JSON.stringify(request);
    } catch {
      return Promise.reject(new Error("bridge request not serializable"));
    }
    if (payload.length > MAX_BRIDGE_MESSAGE_BYTES) {
      return Promise.reject(new Error("bridge request oversized"));
    }
    const runtime = chromeRuntime();
    if (runtime === null) {
      return Promise.reject(new Error("native messaging unavailable"));
    }
    let body: unknown;
    try {
      body = JSON.parse(payload) as unknown;
    } catch {
      return Promise.reject(new Error("bridge request not serializable"));
    }
    return new Promise<unknown>((resolve, reject) => {
      let port: NativePort;
      try {
        port = runtime.connectNative(this.hostName);
      } catch {
        reject(new Error("native host connect failed"));
        return;
      }
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        done(() => {
          try {
            port.disconnect();
          } catch {
            // Already gone; the rejection below is what matters.
          }
          reject(new Error("native host timeout"));
        });
      }, this.timeoutMs);
      const onMessage = (message: unknown): void => {
        // Native hosts may emit stray diagnostics; only the matching reply
        // settles this send. Anything else is ignored, never trusted.
        if (!isRecord(message) || message["requestId"] !== request.requestId) return;
        done(() => {
          try {
            port.disconnect();
          } catch {
            // Reply already received; disconnect is best-effort cleanup.
          }
          resolve(message);
        });
      };
      const onDisconnect = (): void => {
        done(() => reject(new Error("native host disconnected")));
      };
      try {
        port.onMessage.addListener(onMessage);
        port.onDisconnect.addListener(onDisconnect);
        port.postMessage(body);
      } catch {
        done(() => reject(new Error("native host send failed")));
      }
    });
  }
}
