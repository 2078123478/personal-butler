import type { Hex } from "viem";
import {
  AGENT_COMM_DEFAULT_MAX_MESSAGE_BYTES,
  encryptedEnvelopeSchema,
  type EncryptedEnvelope,
} from "./types";

function requireHexPrefix(value: string): string {
  if (!value.startsWith("0x")) {
    throw new Error("Envelope calldata must be 0x-prefixed");
  }
  return value.slice(2);
}

export function encodeEnvelope(envelope: EncryptedEnvelope): Hex {
  const parsed = encryptedEnvelopeSchema.parse(envelope);
  const payload = Buffer.from(JSON.stringify(parsed), "utf8");
  if (payload.byteLength > AGENT_COMM_DEFAULT_MAX_MESSAGE_BYTES) {
    throw new Error(
      `Envelope message exceeds max size: ${payload.byteLength} > ${AGENT_COMM_DEFAULT_MAX_MESSAGE_BYTES} bytes`,
    );
  }
  return `0x${payload.toString("hex")}` as Hex;
}

export function decodeEnvelope(hex: string): EncryptedEnvelope {
  const normalized = requireHexPrefix(hex);
  if (normalized.length === 0 || normalized.length % 2 !== 0) {
    throw new Error("Envelope calldata must be valid hex");
  }
  const payload = Buffer.from(normalized, "hex");
  if (payload.byteLength > AGENT_COMM_DEFAULT_MAX_MESSAGE_BYTES) {
    throw new Error(
      `Envelope message exceeds max size: ${payload.byteLength} > ${AGENT_COMM_DEFAULT_MAX_MESSAGE_BYTES} bytes`,
    );
  }
  const json = payload.toString("utf8");
  return encryptedEnvelopeSchema.parse(JSON.parse(json) as unknown);
}
