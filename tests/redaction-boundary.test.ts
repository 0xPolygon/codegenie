import { afterEach, describe, expect, it } from "vitest";
import { clearRegisteredSecretsForTests, credentialSpans, protectedSourceSlice, redactThenTruncate, registerSecret, stripCredentials } from "../src/telemetry/redaction.js";
import { truncateDiagnostic } from "../src/util/errors.js";
import { buildIntentSignals } from "../src/pipeline/intent-signals.js";

afterEach(clearRegisteredSecretsForTests);

describe("redaction before text caps", () => {
  const secret = "uniqueCredentialABCDEFGHIJKL987654321";
  it("redacts multiline secret components of at least six characters on either page", () => {
    registerSecret("BEGIN\nshort-key-123\nEND");
    expect(stripCredentials("BEGIN\nshort-key-123")).not.toContain("short-key-123");
    expect(stripCredentials("short-key-123\nEND")).not.toContain("short-key-123");
    registerSecret("-----BEGIN PRIVATE KEY-----\nYWJjZGVmZ2hpamtsbW5vcA==\n-----END PRIVATE KEY-----");
    expect(stripCredentials("YWJjZGVmZ2hpamtsbW5vcA==\n-----END PRIVATE KEY-----")).not.toContain("YWJjZGVmZ2hpamtsbW5vcA==");
    registerSecret("BEGIN\nX\nlong-secret-line");
    expect(stripCredentials("BEGIN\nX\n")).toContain("X"); // Components below the existing six-character registration floor remain visible.
    expect(stripCredentials("X\nlong-secret-line")).not.toContain("long-secret-line");
  });
  it.each([1, 4, 13, 20, 0])("does not persist a registered secret with %i characters before the old 2,000-character cut", before => {
    registerSecret(secret);
    const diagnostic = "x".repeat(2_000 - before) + secret + "y".repeat(2_100);
    const output = truncateDiagnostic(diagnostic);
    expect(output).not.toContain(secret);
    expect(output).not.toContain(secret.slice(0, Math.max(before, 4)));
    expect(output.length).toBeLessThanOrEqual(2_000);
  });
  it.each([
    "sk-" + "A1b2C3d4".repeat(4),
    "ghp_" + "A1b2C3d4".repeat(4),
    "eyJ" + "a".repeat(18) + "." + "b".repeat(20) + "." + "c".repeat(20),
    "Bearer " + "A1b2C3d4".repeat(4)
  ])("redacts an unregistered pattern before any boundary can split it", token => {
    const result = redactThenTruncate("x".repeat(65) + " " + token + "!".repeat(200), 90, "...");
    expect(result).not.toContain(token.slice(0, 12));
    expect(result.length).toBeLessThanOrEqual(90);
  });
  it("handles multiple secrets, an intact secret, and a registered partial tail", () => {
    registerSecret(secret); registerSecret("secondCredential987654321");
    const value = "first " + secret + " " + "x".repeat(70) + " " + "secondCredential987654321" + "!".repeat(200);
    const result = redactThenTruncate(value, 100, "...");
    expect(result).not.toContain(secret); expect(result).not.toContain("secondCredential");
    expect(redactThenTruncate("before " + secret + " after", 200)).toBe("before [redacted:secret] after");
    expect(redactThenTruncate("hello " + secret.slice(0, 13) + " rest", 19, "")).not.toContain(secret.slice(0, 13));
    registerSecret("!ABCD EFGH");
    expect(redactThenTruncate("hello !ABCD E and more", 12)).not.toContain("!ABCD ");
  });
  it("redacts overlapping registered values before either replacement obscures the other", () => {
    registerSecret("ABCDEF"); registerSecret("CDEFGH");
    expect(stripCredentials("prefix ABCDEFGH suffix")).toBe("prefix [redacted:secret] suffix");
  });
  it("preserves ordinary text and identifier boundaries and does not split surrogate pairs", () => {
    registerSecret(secret);
    expect(redactThenTruncate("ordinary short text", 200, "...")).toBe("ordinary short text");
    expect(redactThenTruncate("a  z", 3)).toBe("a  ");
    const marker = "\n[validation error truncated by codegenie]";
    expect(truncateDiagnostic("x".repeat(3_000))).toBe("x".repeat(2_000 - marker.length) + marker);
    const hash = "abcdef0123456789".repeat(8);
    expect(redactThenTruncate(hash, 32, "...")).toBe(hash.slice(0, 29) + "...");
    expect(redactThenTruncate("prefix😀suffix", 8, "…")).toBe("prefix…");
  });
});

describe("protected source boundaries", () => {
  it("keeps complete credential examples in model-facing intent text", () => {
    const token = "sk-" + "A1b2C3d4".repeat(4);
    registerSecret("secret with  internal spaces");
    const signals = buildIntentSignals({ pr: { body: `refactor example ${token} and secret with  internal spaces` } });
    expect(signals.signals[0]?.snippet).toContain(token);
    expect(signals.signals[0]?.snippet).toContain("secret with  internal spaces");
    expect(stripCredentials(signals.signals[0]?.snippet ?? "")).not.toContain(token);
  });
  it("keeps registered secrets whole at either boundary, including punctuation", () => {
    const secret = "ABCD!EFGH"; registerSecret(secret);
    const text = `before ${secret} after`;
    const start = text.indexOf(secret), end = start + secret.length;
    expect(protectedSourceSlice(text, 0, start + 4).text).toBe("before ");
    expect(protectedSourceSlice(text, start + 4, text.length).text).toBe(" after");
    expect(protectedSourceSlice(text, start + 2, end - 1).text).toBe("");
    expect(stripCredentials(protectedSourceSlice(text, 0, text.length).text)).not.toContain(secret);
  });
  it.each([
    "https://user:password@host.invalid/path",
    "Authorization: Bearer " + "x".repeat(24),
    "sk-" + "A1b2C3d4".repeat(4)
  ])("does not split protected credentials or overlapping spans: %s", value => {
    registerSecret("user:password");
    const text = `pre ${value} post`;
    const spans = credentialSpans(text);
    for (let i = 1; i < value.length; i++) {
      const cut = 4 + i;
      for (const slice of [protectedSourceSlice(text, 0, cut), protectedSourceSlice(text, cut, text.length)]) {
        for (const [start, end] of spans) {
          expect(slice.start > start && slice.start < end).toBe(false);
          expect(slice.end > start && slice.end < end).toBe(false);
        }
      }
    }
  });
  it("preserves ordinary identifier cuts and retains correct offsets", () => {
    const text = "aaa " + "x".repeat(100) + " end";
    expect(protectedSourceSlice(text, 0, 20)).toEqual({ text: text.slice(0, 20), start: 0, end: 20 });
    expect(protectedSourceSlice(text, 10, 20).text).toBe("x".repeat(10));
    expect(protectedSourceSlice("one two three", 4, 7)).toEqual({ text: "two", start: 4, end: 7 });
  });
  it("never leaves registered fragments at either random cut boundary", () => {
    const secret = "ABCD!EFGH"; registerSecret(secret);
    const text = `before ${secret} between ${secret} after`;
    let seed = 9173;
    for (let i = 0; i < 500; i++) {
      seed = (seed * 16807) % 2147483647; const start = seed % (text.length + 1);
      seed = (seed * 16807) % 2147483647; const end = start + seed % (text.length - start + 1);
      const redacted = stripCredentials(protectedSourceSlice(text, start, end).text);
      for (let a = 0; a <= secret.length - 4; a++) for (let b = a + 4; b <= secret.length; b++) {
        expect(redacted).not.toContain(secret.slice(a, b));
      }
    }
  });
});
