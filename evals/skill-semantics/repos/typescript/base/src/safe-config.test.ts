import { useValidatedConfig } from "./safe-config.js";

function test(_name: string, run: () => void): void {
  run();
}

test("asserts only after runtime validation", () => {
  if (!useValidatedConfig({ url: "https://example.test", retries: 2 })) {
    throw new Error("validated config should reach the consumer");
  }
  try {
    useValidatedConfig({ retries: 2 });
    throw new Error("safe control accepted malformed config");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "invalid config") {
      throw error;
    }
  }
});
