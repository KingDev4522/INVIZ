/**
 * Saved-details contract tests: fixed ordinary-field allowlist, secrets
 * unrepresentable, bounds enforced, never throws.
 * Run: npx vitest run ../shared/profile.test.ts (from frontend/)
 */
import { describe, expect, it } from "vitest";
import { hasProfile, PROFILE_VALUE_MAX_CHARS, sanitizeProfile } from "./profile.js";

describe("sanitizeProfile", () => {
  it("keeps ordinary fields, trims, and drops empties", () => {
    expect(
      sanitizeProfile({ name: "  Ada  ", email: "ada@example.com", phone: "", address: "  " }),
    ).toEqual({ name: "Ada", email: "ada@example.com" });
  });
  it("drops secrets and unknown keys even under innocent names", () => {
    expect(
      sanitizeProfile({
        email: "a@b.c",
        password: "hunter2",
        otp: "123456",
        card: "4111",
        ssn: "000",
        token: "abc",
      }),
    ).toEqual({ email: "a@b.c" });
  });
  it("caps value length and never throws on garbage", () => {
    expect(sanitizeProfile({ name: "x".repeat(500) }).name?.length).toBe(
      PROFILE_VALUE_MAX_CHARS,
    );
    expect(sanitizeProfile(null)).toEqual({});
    expect(sanitizeProfile("email")).toEqual({});
    expect(sanitizeProfile([1, 2])).toEqual({});
    expect(sanitizeProfile({ email: 42 })).toEqual({});
  });
});

describe("hasProfile", () => {
  it("is false when empty, true with any detail", () => {
    expect(hasProfile({})).toBe(false);
    expect(hasProfile({ phone: "+91" })).toBe(true);
  });
});
