import { CodegenieError } from "../util/errors.js";

export type TransportAdmissionReason = "campaign_budget" | "binding_mismatch" | "provider_denied" | "accounting_failed";

/** Internal campaign admission decision made before a physical provider start. */
export class TransportAdmissionError extends CodegenieError {
  readonly reason: TransportAdmissionReason;
  readonly physicalId?: string;

  constructor(reason: TransportAdmissionReason, physicalId?: string) {
    if (physicalId !== undefined && !/^[A-Za-z0-9._:/-]{1,160}$/u.test(physicalId)) throw new TypeError("invalid physical ID");
    super(reason === "campaign_budget" ? "budget_exhausted" : "config_error", "Provider transport admission denied", {
      recoverable: false, context: { reason, ...(physicalId !== undefined ? { physicalId } : {}) }
    });
    this.name = "TransportAdmissionError";
    this.reason = reason;
    if (physicalId !== undefined) this.physicalId = physicalId;
  }
}

/** Retain typed local denials even if a provider adapter converts them to text. */
export function captureTransportAdmission(delegate: typeof globalThis.fetch): {
  fetch: typeof globalThis.fetch;
  denial(): TransportAdmissionError | undefined;
  deny(error: TransportAdmissionError): void;
} {
  let failure: TransportAdmissionError | undefined;
  return {
    fetch: async (input, init) => {
      if (failure !== undefined) throw failure;
      try { return await delegate(input, init); }
      catch (error) {
        if (error instanceof TransportAdmissionError) failure = error;
        throw error;
      }
    },
    denial: () => failure,
    deny: (error) => { failure ??= error; }
  };
}

export type ProviderUsageObservation = {
  source: "provider_chunk" | "terminal";
  usagePresent: boolean;
  costPresent: boolean;
  reasoningTokensPresent: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  providerCost?: number;
  providerBilledCost?: number;
  isByok?: boolean;
  terminal?: "done" | "error" | "aborted";
  costFromProvider?: boolean;
};

type UnknownRecord = Record<string, unknown>;
const asRecord = (value: unknown): UnknownRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Project only usage and explicit presence from an OpenRouter provider chunk. */
export function projectProviderUsage(chunk: unknown): ProviderUsageObservation | undefined {
  const root = asRecord(chunk);
  if (!root || !Object.hasOwn(root, "usage")) return undefined;
  const usage = asRecord(root.usage);
  const details = asRecord(usage?.completion_tokens_details);
  const inputTokens = numberValue(usage?.prompt_tokens);
  const outputTokens = numberValue(usage?.completion_tokens);
  const totalTokens = numberValue(usage?.total_tokens);
  const reasoningTokens = numberValue(details?.reasoning_tokens);
  const providerCost = numberValue(usage?.cost);
  const isByok = typeof usage?.is_byok === "boolean" ? usage.is_byok : undefined;
  const costDetails = asRecord(usage?.cost_details);
  let providerBilledCost: number | undefined;
  if (providerCost !== undefined && isByok === false) providerBilledCost = providerCost;
  if (providerCost !== undefined && isByok === true && costDetails !== undefined) {
    let upstream = numberValue(costDetails.upstream_inference_cost);
    if (costDetails.upstream_inference_cost === null) {
      const prompt = numberValue(costDetails.upstream_inference_prompt_cost);
      const completion = numberValue(costDetails.upstream_inference_completions_cost);
      if (prompt !== undefined && completion !== undefined) upstream = prompt + completion;
    }
    if (upstream !== undefined && Number.isFinite(providerCost + upstream)) providerBilledCost = providerCost + upstream;
  }
  return {
    source: "provider_chunk", usagePresent: true,
    costPresent: usage !== undefined && Object.hasOwn(usage, "cost"),
    reasoningTokensPresent: details !== undefined && Object.hasOwn(details, "reasoning_tokens"),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(providerCost !== undefined ? { providerCost } : {}),
    ...(providerBilledCost !== undefined ? { providerBilledCost } : {}),
    ...(isByok !== undefined ? { isByok } : {})
  };
}
