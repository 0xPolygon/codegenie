import { ReviewTargetUsageError } from "../util/errors.js";
import { safeDiagnosticLine } from "../util/review-health.js";

type RenderableError = {
  code: string;
  message: string;
  context?: Record<string, unknown>;
};

export function renderCodegenieError(error: RenderableError): string {
  if (error instanceof ReviewTargetUsageError) {
    return [
      `${error.code}: ${safeDiagnosticLine(error.message)}`,
      "",
      "Review target examples",
      "  codegenie review HEAD",
      "  codegenie review <branch>",
      "  codegenie review origin/main...HEAD",
      "  codegenie review --pr N",
      ""
    ].join("\n");
  }
  const helpText = typeof error.context?.helpText === "string" ? error.context.helpText.trimEnd() : undefined;
  const hint = typeof error.context?.hint === "string" ? error.context.hint : undefined;
  if (helpText !== undefined) {
    return `${error.message}\n\n${helpText}${hint !== undefined ? `\n\n${hint}` : ""}\n`;
  }
  // The provider's own explanation is the actionable half of an LLM failure —
  // a usage-limit rejection reads as a generic error code without it.
  const providerMessage =
    typeof error.context?.providerMessage === "string" ? error.context.providerMessage.trim() : undefined;
  if (providerMessage !== undefined && providerMessage.length > 0) {
    return `${error.code}: ${error.message}\n${providerMessage}\n`;
  }
  return `${error.code}: ${error.message}\n`;
}
