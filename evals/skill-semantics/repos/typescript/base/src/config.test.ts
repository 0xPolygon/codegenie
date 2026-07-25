import { useConfig } from "./config.js";

function test(_name: string, run: () => void): void {
  run();
}

test("rejects malformed config before the runtime consumer", () => {
  try {
    useConfig({ retries: 2 });
    throw new Error("malformed config was accepted");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "invalid config") {
      throw new Error("malformed config reached runtime consumer", { cause: error });
    }
  }
});
