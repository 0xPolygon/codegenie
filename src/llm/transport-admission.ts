import { CodegenieError } from "../util/errors.js";

export type TransportAdmissionReason = "campaign_budget" | "binding_mismatch" | "provider_denied";

/** Internal campaign admission decision made before a physical provider start. */
export class TransportAdmissionError extends CodegenieError {
  readonly reason: TransportAdmissionReason;

  constructor(reason: TransportAdmissionReason) {
    super(reason === "campaign_budget" ? "budget_exhausted" : "config_error", "Provider transport admission denied", {
      recoverable: false, context: { reason }
    });
    this.name = "TransportAdmissionError";
    this.reason = reason;
  }
}

/** Retain typed local denials even if a provider adapter converts them to text. */
export function captureTransportAdmission(delegate: typeof globalThis.fetch): {
  fetch: typeof globalThis.fetch;
  denial(): TransportAdmissionError | undefined;
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
    denial: () => failure
  };
}
