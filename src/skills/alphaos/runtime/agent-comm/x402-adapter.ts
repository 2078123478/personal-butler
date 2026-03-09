import type { StateStore } from "../state-store";
import { getAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import type { X402Mode, X402Proof } from "./types";

export interface X402AdapterOptions {
  mode: X402Mode;
  store: StateStore;
  now?: Date;
  localPayees?: string[];
  expectedPayment?: {
    asset?: string;
    amount?: string;
  };
}

export interface X402VerificationResult {
  valid: boolean;
  payer?: string;
  amount?: string;
  asset?: string;
  payee?: string;
  error?: string;
}

type CanonicalJson =
  | string
  | number
  | boolean
  | null
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRequiredString(value: unknown, field: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`missing required field: ${field}`);
  }
  return normalized;
}

function normalizeAddress(value: string, field: string): Address {
  try {
    return getAddress(value);
  } catch {
    throw new Error(`invalid ${field}: expected EVM address`);
  }
}

function isExpectedPaymentMismatch(expected: string | undefined, actual: string): boolean {
  if (!expected) {
    return false;
  }
  return expected.trim() !== actual;
}

function toCanonicalJson(value: unknown): CanonicalJson {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error("invalid x402 metadata: non-finite number");
      }
      return value;
    case "object":
      if (Array.isArray(value)) {
        return value.map((item) => toCanonicalJson(item));
      }

      const output: { [key: string]: CanonicalJson } = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const child = (value as Record<string, unknown>)[key];
        if (child === undefined) {
          continue;
        }
        output[key] = toCanonicalJson(child);
      }
      return output;
    default:
      throw new Error(`invalid x402 metadata: unsupported type ${typeof value}`);
  }
}

function toStableJsonString(value: Record<string, unknown>): string {
  return JSON.stringify(toCanonicalJson(value));
}

function buildLocalPayeeCandidates(options: X402AdapterOptions): Set<Address> {
  const identities = options.store.listAgentLocalIdentities(10);
  const rawCandidates = [
    ...(options.localPayees ?? []),
    ...identities.map((identity) => identity.walletAddress),
    ...identities.map((identity) => identity.identityWallet),
  ];

  const candidates = new Set<Address>();
  for (const candidate of rawCandidates) {
    const normalized = normalizeOptionalString(candidate);
    if (!normalized) {
      continue;
    }
    try {
      candidates.add(getAddress(normalized));
    } catch {
      // Ignore malformed local candidate values and keep evaluating other sources.
    }
  }
  return candidates;
}

export function buildX402SigningPayload(proof: X402Proof): string {
  const payload: Record<string, unknown> = {
    scheme: proof.scheme,
    payer: readRequiredString(proof.payer, "payer"),
    asset: readRequiredString(proof.asset, "asset"),
    amount: readRequiredString(proof.amount, "amount"),
    nonce: readRequiredString(proof.nonce, "nonce"),
  };

  const optionalFields: Array<keyof Pick<
    X402Proof,
    "version" | "network" | "payee" | "expiresAt"
  >> = ["version", "network", "payee", "expiresAt"];
  for (const field of optionalFields) {
    const normalized = normalizeOptionalString(proof[field]);
    if (normalized) {
      payload[field] = normalized;
    }
  }

  if (proof.metadata !== undefined) {
    payload.metadata = proof.metadata;
  }

  return toStableJsonString(payload);
}

export async function verifyX402Proof(
  options: X402AdapterOptions,
  proof: X402Proof,
): Promise<X402VerificationResult> {
  if (options.mode === "disabled") {
    return { valid: true };
  }

  try {
    if (proof.scheme !== "x402") {
      return { valid: false, error: "invalid proof scheme" };
    }

    const payer = readRequiredString(proof.payer, "payer");
    const asset = readRequiredString(proof.asset, "asset");
    const amount = readRequiredString(proof.amount, "amount");
    const nonce = readRequiredString(proof.nonce, "nonce");
    const signature = readRequiredString(proof.signature, "signature");
    const payee = normalizeOptionalString(proof.payee);
    const expiresAt = normalizeOptionalString(proof.expiresAt);

    if (isExpectedPaymentMismatch(options.expectedPayment?.asset, asset)) {
      return { valid: false, error: "proof asset does not match payment asset" };
    }
    if (isExpectedPaymentMismatch(options.expectedPayment?.amount, amount)) {
      return { valid: false, error: "proof amount does not match payment amount" };
    }

    if (expiresAt) {
      const expiresAtMs = Date.parse(expiresAt);
      if (!Number.isFinite(expiresAtMs)) {
        return { valid: false, error: "invalid expiresAt" };
      }
      const nowMs = (options.now ?? new Date()).getTime();
      if (expiresAtMs <= nowMs) {
        return { valid: false, error: "proof expired" };
      }
    }

    const signingPayload = buildX402SigningPayload({
      ...proof,
      payer,
      asset,
      amount,
      nonce,
      signature,
      ...(payee ? { payee } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    });
    const recoveredSigner = await recoverMessageAddress({
      message: signingPayload,
      signature: signature as Hex,
    });
    const normalizedRecoveredSigner = getAddress(recoveredSigner);
    const normalizedPayer = normalizeAddress(payer, "payer");
    if (normalizedRecoveredSigner !== normalizedPayer) {
      return { valid: false, error: "payer does not match recovered signer" };
    }

    if (!payee) {
      return { valid: true, payer: normalizedPayer, amount, asset };
    }

    const normalizedPayee = normalizeAddress(payee, "payee");
    const localPayees = buildLocalPayeeCandidates(options);
    if (localPayees.size === 0 || !localPayees.has(normalizedPayee)) {
      return { valid: false, error: "payee does not match local receive address" };
    }

    return {
      valid: true,
      payer: normalizedPayer,
      amount,
      asset,
      payee: normalizedPayee,
    };
  } catch (error) {
    return { valid: false, error: toErrorMessage(error) };
  }
}

export async function verifyX402(
  options: X402AdapterOptions,
  proof: X402Proof,
): Promise<X402VerificationResult> {
  return verifyX402Proof(options, proof);
}
