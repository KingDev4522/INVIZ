/**
 * NativeMessagingTransport tests: request/response matching over a fake
 * chrome.runtime.connectNative port. No real native host, no network.
 * Run: npm test
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeMessagingTransport } from "./native-transport.js";
import type { BridgeRequest } from "../../../shared/bridge-protocol.js";

interface FakePort {
  posted: unknown[];
  disconnects: number;
  messageListeners: Array<(message: unknown) => void>;
  disconnectListeners: Array<() => void>;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: {
    addListener(callback: (message: unknown) => void): void;
    removeListener(callback: (message: unknown) => void): void;
  };
  onDisconnect: { addListener(callback: () => void): void };
}

function makePort(): FakePort {
  const port: FakePort = {
    posted: [],
    disconnects: 0,
    messageListeners: [],
    disconnectListeners: [],
    postMessage(message: unknown): void {
      port.posted.push(message);
    },
    disconnect(): void {
      port.disconnects += 1;
    },
    onMessage: {
      addListener(callback: (message: unknown) => void): void {
        port.messageListeners.push(callback);
      },
      removeListener(callback: (message: unknown) => void): void {
        port.messageListeners = port.messageListeners.filter((c) => c !== callback);
      },
    },
    onDisconnect: {
      addListener(callback: () => void): void {
        port.disconnectListeners.push(callback);
      },
    },
  };
  return port;
}

function installChrome(connect: (hostName: string) => FakePort): void {
  (globalThis as unknown as { chrome?: unknown }).chrome = {
    runtime: { connectNative: connect },
  };
}

function uninstallChrome(): void {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
}

function request(overrides: Partial<BridgeRequest> = {}): BridgeRequest {
  return {
    protocolVersion: 1,
    requestId: "bh_t_1",
    taskId: "t",
    capability: "click",
    args: { target: "e2", node: { role: "button", name: "Submit" } },
    ...overrides,
  };
}

afterEach(() => {
  uninstallChrome();
  vi.useRealTimers();
});

describe("NativeMessagingTransport", () => {
  it("posts the request and resolves with the matching reply", async () => {
    const port = makePort();
    let seenHost = "";
    installChrome((hostName: string) => {
      seenHost = hostName;
      return port;
    });
    const transport = new NativeMessagingTransport();
    const pending = transport.send(request());
    expect(port.posted).toHaveLength(1);
    const posted = port.posted[0] as Record<string, unknown>;
    expect(posted["requestId"]).toBe("bh_t_1");
    expect(posted["args"]).toEqual({ target: "e2", node: { role: "button", name: "Submit" } });
    port.messageListeners.forEach((cb) => cb({ requestId: "bh_t_1", ok: true }));
    await expect(pending).resolves.toEqual({ requestId: "bh_t_1", ok: true });
    expect(seenHost).toBe("com.inviz.harness");
    expect(port.disconnects).toBe(1);
  });

  it("ignores stray messages with other request ids", async () => {
    const port = makePort();
    installChrome(() => port);
    const transport = new NativeMessagingTransport();
    const pending = transport.send(request());
    port.messageListeners.forEach((cb) => cb({ requestId: "someone-else", ok: true }));
    port.messageListeners.forEach((cb) => cb({ requestId: "bh_t_1", ok: false }));
    await expect(pending).resolves.toEqual({ requestId: "bh_t_1", ok: false });
  });

  it("rejects when the host disconnects without replying", async () => {
    const port = makePort();
    installChrome(() => port);
    const transport = new NativeMessagingTransport();
    const pending = transport.send(request());
    const assertion = expect(pending).rejects.toThrow("disconnected");
    port.disconnectListeners.forEach((cb) => cb());
    await assertion;
  });

  it("rejects on timeout when the host stays silent", async () => {
    installChrome(() => makePort());
    const transport = new NativeMessagingTransport("com.inviz.harness", 15);
    await expect(transport.send(request())).rejects.toThrow("timeout");
  });

  it("rejects when native messaging is unavailable", async () => {
    uninstallChrome();
    const transport = new NativeMessagingTransport();
    await expect(transport.send(request())).rejects.toThrow("unavailable");
  });

  it("rejects oversized requests before touching the port", async () => {
    let connected = 0;
    installChrome(() => {
      connected += 1;
      return makePort();
    });
    const transport = new NativeMessagingTransport();
    await expect(
      transport.send(request({ args: { target: "e2", pad: "x".repeat(70_000) } })),
    ).rejects.toThrow("oversized");
    expect(connected).toBe(0);
  });
});
