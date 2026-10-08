import { describe, expect, it } from "vitest";
import { formatDiagEntry, pushDiag, type DiagEntry } from "./diag.js";

function entry(t: number, kind = "turn", text = "capture started"): DiagEntry {
  return { t, kind, text };
}

describe("diag ring buffer", () => {
  it("appends entries in order", () => {
    const log = pushDiag(pushDiag([], entry(1)), entry(2, "done", "ok"));
    expect(log.length).toBe(2);
    expect(log[1]?.kind).toBe("done");
  });

  it("caps at the limit, oldest dropped first", () => {
    let log: DiagEntry[] = [];
    for (let i = 0; i < 30; i += 1) log = pushDiag(log, entry(i));
    expect(log.length).toBe(25);
    expect(log[0]?.t).toBe(5);
    expect(log[24]?.t).toBe(29);
  });

  it("formats one readable line without speech content", () => {
    const line = formatDiagEntry(entry(1_700_000_000_000, "failed", "TRANSCRIPTION_FAILED: boom"));
    expect(line).toContain("failed");
    expect(line).toContain("TRANSCRIPTION_FAILED: boom");
  });
});
