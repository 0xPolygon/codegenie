import { describe, expect, it } from "vitest";
import { clearRegisteredSecretsForTests, registerSecret } from "../src/telemetry/redaction.js";
import { CodegenieError } from "../src/util/errors.js";

describe("CodegenieError", () => {
  it("strips credential material from context", () => {
    clearRegisteredSecretsForTests();
    registerSecret("private-token-value");

    const error = new CodegenieError("config_error", "bad config", {
      context: {
        token: "private-token-value",
        stderr: "Authorization: Bearer private-token-value",
        url: "https://user:private-token-value@example.com/repo.git"
      }
    });

    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain("private-token-value");
    expect(serialized).toContain("[redacted:secret]");
    expect(serialized).toContain("https://[redacted]@example.com");
    expect(error.code).toBe("config_error");
    expect(error.recoverable).toBe(false);
    clearRegisteredSecretsForTests();
  });
});
