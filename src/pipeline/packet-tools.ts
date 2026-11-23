import type { ReviewPacket } from "../types.js";

export function packetHasRepositoryTools(packet: Pick<ReviewPacket, "reviewProfile" | "toolBudget">): boolean {
  return packet.reviewProfile !== "simple" && packet.toolBudget.maxToolCalls > 0;
}
