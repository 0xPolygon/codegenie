import { validateToolCall as validatePiToolCall, type ToolCall } from "@earendil-works/pi-ai";
import type { PiAiAdapter } from "../../src/llm/llm-runner.js";

// Mirror the production adapter boundary. Fixtures deliberately include invalid
// arguments, so retain unknown input types and let Pi perform real validation.
export const validateToolCall: PiAiAdapter["validateToolCall"] = (tools, call) =>
  validatePiToolCall(tools, call as ToolCall);
