import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { StateStore } from "../state-store";
import type { ShadowWallet } from "./shadow-wallet";
import { decodeEnvelope } from "./calldata-codec";
import type { AgentCommandType, AgentMessage } from "./types";

export interface OutboundMessageContext {
  peerId: string;
  messageId?: string;
  nonce: string;
  commandType: AgentCommandType;
  envelopeVersion?: number;
  msgId?: string;
  contactId?: string;
  identityWallet?: string;
  transportAddress?: string;
  trustOutcome?: string;
  decryptedCommandType?: AgentCommandType;
}

export interface TxSenderOptions {
  rpcUrl: string;
  chainId: number;
  walletAlias: string;
  relayUrl?: string;
  relayTimeoutMs?: number;
  submitMode?: "direct" | "relay";
  store?: StateStore;
  outboundMessage?: OutboundMessageContext;
}

export interface SendResult {
  txHash: string;
  nonce: string;
  sentAt: string;
}

export interface RelaySubmitOptions {
  relayUrl: string;
  relayTimeoutMs?: number;
  chainId: number;
  rawTransaction: Hex;
  from: Address;
  to: Address;
  data: Hex;
  nonce: number;
}

interface PersistOutboundMessagePayload {
  nonce: string;
  commandType: AgentCommandType;
  envelopeVersion?: number;
  msgId?: string;
  contactId?: string;
  identityWallet?: string;
  transportAddress?: string;
  trustOutcome?: string;
  decryptedCommandType?: AgentCommandType;
  ciphertext: string;
  txHash?: string;
  sentAt?: string;
  error?: string;
}

interface ResolvedOutboundMessagePayload {
  resultNonce: string;
  persistPayload: PersistOutboundMessagePayload;
}

function normalizeAddress(value: string, label: string): Address {
  try {
    return getAddress(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label}: ${reason}`);
  }
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pickPayload(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const data = obj.data;
    if (Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === "object") {
      return data[0] as Record<string, unknown>;
    }
    if (data && typeof data === "object") {
      return data as Record<string, unknown>;
    }
    return obj;
  }
  return {};
}

function pickString(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

export async function submitViaRelay(options: RelaySubmitOptions): Promise<string> {
  const relayUrl = options.relayUrl.trim();
  if (!relayUrl) {
    throw new Error("Relay URL is required");
  }

  const relayTimeoutMs = Math.max(1, Math.floor(options.relayTimeoutMs ?? 10_000));
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, relayTimeoutMs);

  try {
    const response = await fetch(relayUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chainId: options.chainId,
        from: options.from,
        to: options.to,
        data: options.data,
        nonce: options.nonce,
        rawTransaction: options.rawTransaction,
        rawTx: options.rawTransaction,
      }),
      signal: controller.signal,
    });

    const rawText = await response.text();
    let parsedBody: unknown = {};
    if (rawText.trim()) {
      try {
        parsedBody = JSON.parse(rawText) as unknown;
      } catch {
        parsedBody = {
          message: rawText.slice(0, 280),
        };
      }
    }
    const payload = pickPayload(parsedBody);

    if (!response.ok) {
      const reason =
        pickString(payload, ["error", "message", "msg"])
        ?? `${response.status} ${response.statusText}`.trim();
      throw new Error(`Relay submit failed: ${reason}`);
    }

    const txHash = pickString(payload, ["txHash", "hash", "transactionHash"]);
    if (!txHash) {
      throw new Error("Relay submit response missing txHash");
    }
    return txHash;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Relay submit timed out after ${relayTimeoutMs}ms`);
    }
    if (error instanceof Error && error.message.startsWith("Relay submit failed:")) {
      throw error;
    }
    throw new Error(`Relay submit failed: ${toErrorMessage(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function createCommChain(options: TxSenderOptions) {
  return defineChain({
    id: options.chainId,
    name: `agent-comm-${options.chainId}`,
    nativeCurrency: {
      name: "Ether",
      symbol: "ETH",
      decimals: 18,
    },
    rpcUrls: {
      default: {
        http: [options.rpcUrl],
      },
    },
  });
}

async function sendTransaction(
  options: TxSenderOptions,
  walletClient: ReturnType<typeof createWalletClient>,
  account: ReturnType<typeof privateKeyToAccount>,
  chain: ReturnType<typeof createCommChain>,
  targetAddress: Address,
  calldata: Hex,
  txNonce: number,
): Promise<string> {
  const relayUrl = options.relayUrl?.trim();
  const relayConfigured = Boolean(relayUrl);
  const submitMode = options.submitMode === "relay" ? "relay" : "direct";
  const attempts: Array<{ mode: "direct" | "relay"; submit: () => Promise<string> }> = [];

  const submitDirect = async () =>
    walletClient.sendTransaction({
      account,
      chain,
      to: targetAddress,
      value: 0n,
      data: calldata,
      nonce: txNonce,
    });

  const submitRelay = async () => {
    if (!relayUrl) {
      throw new Error("COMM_RELAY_URL is not configured");
    }
    const rawTransaction = await walletClient.signTransaction({
      account,
      chain,
      to: targetAddress,
      value: 0n,
      data: calldata,
      nonce: txNonce,
    });

    return submitViaRelay({
      relayUrl,
      relayTimeoutMs: options.relayTimeoutMs,
      chainId: options.chainId,
      rawTransaction,
      from: account.address,
      to: targetAddress,
      data: calldata,
      nonce: txNonce,
    });
  };

  if (submitMode === "relay" && relayConfigured) {
    attempts.push({ mode: "relay", submit: submitRelay });
  }
  attempts.push({ mode: "direct", submit: submitDirect });
  if (submitMode === "direct" && relayConfigured) {
    attempts.push({ mode: "relay", submit: submitRelay });
  }

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      return await attempt.submit();
    } catch (error) {
      errors.push(`${attempt.mode}: ${toErrorMessage(error)}`);
    }
  }

  throw new Error(`Failed to submit transaction: ${errors.join("; ")}`);
}

function resolveExistingOutboundMessage(
  store: StateStore,
  outboundMessage: OutboundMessageContext,
  nonce: string,
): AgentMessage | null {
  const existingMessageById = outboundMessage.messageId
    ? store.getAgentMessage(outboundMessage.messageId)
    : null;
  if (!existingMessageById) {
    return store.findAgentMessage(outboundMessage.peerId, "outbound", nonce);
  }
  if (
    existingMessageById.direction !== "outbound" ||
    existingMessageById.peerId !== outboundMessage.peerId ||
    existingMessageById.nonce !== nonce
  ) {
    throw new Error(`Outbound message context mismatch for ${existingMessageById.id}`);
  }
  return existingMessageById;
}

function persistOutboundMessage(
  options: TxSenderOptions,
  payload: PersistOutboundMessagePayload,
): void {
  const { store, outboundMessage } = options;
  if (!store || !outboundMessage) {
    return;
  }

  const existingMessage = resolveExistingOutboundMessage(store, outboundMessage, payload.nonce);
  const status = payload.txHash ? "sent" : "failed";

  if (existingMessage) {
    store.updateAgentMessageStatus(existingMessage.id, status, {
      txHash: payload.txHash,
      envelopeVersion: payload.envelopeVersion,
      msgId: payload.msgId,
      contactId: payload.contactId,
      identityWallet: payload.identityWallet,
      transportAddress: payload.transportAddress,
      trustOutcome: payload.trustOutcome,
      decryptedCommandType: payload.decryptedCommandType,
      sentAt: payload.sentAt,
      error: payload.error,
    });
    return;
  }

  store.insertAgentMessage({
    id: outboundMessage.messageId,
    direction: "outbound",
    peerId: outboundMessage.peerId,
    txHash: payload.txHash,
    nonce: payload.nonce,
    commandType: payload.commandType,
    envelopeVersion: payload.envelopeVersion,
    msgId: payload.msgId,
    contactId: payload.contactId,
    identityWallet: payload.identityWallet,
    transportAddress: payload.transportAddress,
    trustOutcome: payload.trustOutcome,
    decryptedCommandType: payload.decryptedCommandType,
    ciphertext: payload.ciphertext,
    status,
    sentAt: payload.sentAt,
    error: payload.error,
  });
}

function resolveOutboundMessagePayload(
  options: TxSenderOptions,
  envelope: ReturnType<typeof decodeEnvelope>,
): ResolvedOutboundMessagePayload {
  const outboundMessage = options.outboundMessage;
  const resultNonce = outboundMessage?.nonce ?? (envelope.version === 1 ? envelope.nonce : "");

  return {
    resultNonce,
    persistPayload: {
      nonce: outboundMessage?.nonce ?? (envelope.version === 1 ? envelope.nonce : crypto.randomUUID()),
      commandType: outboundMessage?.commandType ?? (envelope.version === 1 ? envelope.command.type : "ping"),
      envelopeVersion: outboundMessage?.envelopeVersion ?? envelope.version,
      msgId: outboundMessage?.msgId,
      contactId: outboundMessage?.contactId,
      identityWallet: outboundMessage?.identityWallet,
      transportAddress: outboundMessage?.transportAddress,
      trustOutcome: outboundMessage?.trustOutcome,
      decryptedCommandType: outboundMessage?.decryptedCommandType,
      ciphertext: envelope.ciphertext,
    },
  };
}

export async function sendCalldata(
  options: TxSenderOptions,
  wallet: ShadowWallet,
  toAddress: string,
  calldata: Hex,
): Promise<SendResult> {
  const envelope = decodeEnvelope(calldata);
  const targetAddress = normalizeAddress(toAddress, "toAddress");

  if (envelope.version === 1) {
    const recipient = normalizeAddress(envelope.recipient, "envelope recipient");

    if (recipient !== targetAddress) {
      throw new Error(
        `Envelope recipient mismatch: expected ${targetAddress}, received ${recipient}`,
      );
    }

    if (!sameHex(wallet.getPublicKey(), envelope.senderPubkey)) {
      throw new Error(
        `Envelope senderPubkey does not match wallet alias "${options.walletAlias}"`,
      );
    }
  }

  const chain = createCommChain(options);
  const publicClient = createPublicClient({
    chain,
    transport: http(options.rpcUrl),
  });
  const account = privateKeyToAccount(wallet.privateKey);
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(options.rpcUrl),
  });

  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== options.chainId) {
    throw new Error(
      `RPC chainId mismatch: expected ${options.chainId}, received ${rpcChainId}`,
    );
  }

  const txNonce = await publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  const sentAt = new Date().toISOString();
  const outboundMessagePayload = resolveOutboundMessagePayload(options, envelope);

  try {
    const txHash = await sendTransaction(
      options,
      walletClient,
      account,
      chain,
      targetAddress,
      calldata,
      txNonce,
    );

    persistOutboundMessage(options, {
      ...outboundMessagePayload.persistPayload,
      txHash,
      sentAt,
    });

    return {
      txHash,
      nonce: outboundMessagePayload.resultNonce,
      sentAt,
    };
  } catch (error) {
    const reason = toErrorMessage(error);
    persistOutboundMessage(options, {
      ...outboundMessagePayload.persistPayload,
      error: reason,
    });
    throw new Error(
      `Failed to send calldata transaction on chain ${options.chainId}: ${reason}`,
    );
  }
}
