import { afterEach, describe, expect, it } from "vitest";
import { clearRegisteredSecretsForTests, credentialSafeCut, redactThenTruncate, registerSecret, stripCredentials, stripCredentialsAtSink } from "../src/telemetry/redaction.js";
import { truncateDiagnostic } from "../src/util/errors.js";

afterEach(clearRegisteredSecretsForTests);

describe("model-facing credential cuts", () => {
  it.each([
    "sk-" + "A1b2".repeat(400),
    "Authorization: Bearer " + "A1b2".repeat(400),
    "https://" + "A1b2".repeat(400) + "@example.invalid"
  ])("retreats through a long recognized span and preserves cuts at its endpoints", (credential) => {
    const prefix = "before ";
    const text = prefix + credential + "\nafter";
    const end = prefix.length + (credential.startsWith("https:") ? credential.indexOf("@") + 1 : credential.length);
    expect(credentialSafeCut(text, prefix.length)).toBe(prefix.length);
    expect(credentialSafeCut(text, prefix.length + 800)).toBe(prefix.length);
    expect(credentialSafeCut(text, end)).toBe(end);
  });

  it("retreats through overlapping registered values and ignores sink-only components", () => {
    registerSecret("ABCDEF");
    registerSecret("CDEFGH");
    registerSecret("header\nstandaloneComponent\nfooter");
    expect(credentialSafeCut("prefix ABCDEFGH suffix", 14)).toBe(7);
    expect(credentialSafeCut("prefix standaloneComponent suffix", 13)).toBe(13);
  });

  it("keeps real regex word boundaries and intact ordinary field names", () => {
    const looksLikeToken = "xsk-" + "a".repeat(900);
    expect(credentialSafeCut(looksLikeToken, 700)).toBe(700);
    const name = "field".repeat(50);
    expect(credentialSafeCut(name, 200)).toBe(200);
  });

  it("finds eligible starts inside URL and JWT runs without mistaking a long ordinary run for a credential", () => {
    const prefix = "123.";
    const url = "https://synthetic-credential@example.invalid";
    expect(credentialSafeCut(prefix + url, prefix.length + 13)).toBe(prefix.length);
    const jwt = "eyJ" + ["a", "b", "c"].map(letter => letter.repeat(20)).join(".");
    expect(credentialSafeCut("label-" + jwt, 25)).toBe("label-".length);
    const ordinary = "word.".repeat(100_000) + "eyJ-".repeat(100_000);
    expect(credentialSafeCut(ordinary, 200)).toBe(200);
  });
});

describe("redaction before text caps", () => {
  const secret = "uniqueCredentialABCDEFGHIJKL987654321";
  it("redacts multiline secret components of at least six characters on either page", () => {
    registerSecret("BEGIN\nshort-key-123\nEND");
    expect(stripCredentialsAtSink("BEGIN\nshort-key-123")).not.toContain("short-key-123");
    expect(stripCredentialsAtSink("short-key-123\nEND")).not.toContain("short-key-123");
    registerSecret("-----BEGIN PRIVATE KEY-----\nYWJjZGVmZ2hpamtsbW5vcA==\n-----END PRIVATE KEY-----");
    expect(stripCredentialsAtSink("YWJjZGVmZ2hpamtsbW5vcA==\n-----END PRIVATE KEY-----")).not.toContain("YWJjZGVmZ2hpamtsbW5vcA==");
    registerSecret("BEGIN\nX\nlong-secret-line");
    expect(stripCredentialsAtSink("BEGIN\nX\n")).toContain("X"); // Components below the existing six-character registration floor remain visible.
    expect(stripCredentialsAtSink("X\nlong-secret-line")).not.toContain("long-secret-line");
  });
  it.each([1, 4, 13, 20, 0])("does not persist a registered secret with %i characters before the old 2,000-character cut", before => {
    registerSecret(secret);
    const diagnostic = "x".repeat(2_000 - before) + secret + "y".repeat(2_100);
    const output = truncateDiagnostic(diagnostic);
    expect(output).not.toContain(secret);
    expect(output).not.toContain(secret.slice(0, Math.max(before, 4)));
    expect(output.length).toBeLessThanOrEqual(2_000 + "\n[validation error truncated by codegenie]".length);
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
    expect(stripCredentialsAtSink("prefix ABCDEFGH suffix")).toBe("prefix [redacted:secret] suffix");
  });
  it("preserves ordinary text and identifier boundaries and does not split surrogate pairs", () => {
    registerSecret(secret);
    expect(redactThenTruncate("ordinary short text", 200, "...")).toBe("ordinary short text");
    expect(redactThenTruncate("a  z", 3)).toBe("a  ");
    const marker = "\n[validation error truncated by codegenie]";
    expect(truncateDiagnostic("x".repeat(3_000))).toBe("x".repeat(2_000) + marker);
    const hash = "abcdef0123456789".repeat(8);
    expect(redactThenTruncate(hash, 32, "...")).toBe(hash.slice(0, 29) + "...");
    expect(redactThenTruncate("prefix😀suffix", 8, "…")).toBe("prefix…");
  });
  it.each([2_000, 2_001, 2_020])("preserves the original plain diagnostic boundary at %i characters", length => {
    const value = "x".repeat(length);
    const marker = "\n[validation error truncated by codegenie]";
    expect(truncateDiagnostic(value)).toBe(length <= 2_000 ? value : value.slice(0, 2_000).trimEnd() + marker);
  });
  it("keeps the existing UTF-16 boundary for ordinary repair diagnostics", () => {
    const value = "x".repeat(1_999) + "😀" + "z";
    expect(truncateDiagnostic(value)).toBe(value.slice(0, 2_000) + "\n[validation error truncated by codegenie]");
  });
});
