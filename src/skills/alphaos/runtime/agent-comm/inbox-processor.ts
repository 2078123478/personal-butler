import { getAddress, type Address } from "viem";
import type { StateStore } from "../state-store";
import { decodeEnvelope } from "./calldata-codec";
import { decrypt, deriveSharedKey } from "./ecdh-crypto";
import type { ShadowWallet } from "./shadow-wallet";
import {
  agentCommandSchema,
  isBusinessCommandType,
  isConnectionCommandType,
  type AgentCommand,
  type AgentConnectionEventStatus,
  type AgentConnectionEventType,
  type AgentContact,
  type AgentMessage,
  type AgentMessageStatus,
  type AgentPeer,
} from "./types";
import type { TransactionEvent } from "./tx-listener";

export interface InboxProcessorOptions {
  wallet: ShadowWallet;
  store: StateStore;
}

export interface ProcessInboxResult {
  message: AgentMessage;
  command: AgentCommand;
}

export class InboxProcessingError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "InboxProcessingError";
    this.code = code;
    this.details = details;
  }
}

function normalizeAddress(value: string, label: string): Address {
  try {
    return getAddress(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new InboxProcessingError("INVALID_ADDRESS", `Invalid ${label}: ${reason}`, {
      value,
    });
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withInboxError<T>(
  code: string,
  message: string,
  details: Record<string, unknown> | undefined,
  run: () => T,
): T {
  try {
    return run();
  } catch (error) {
    throw new InboxProcessingError(code, `${message}: ${toErrorMessage(error)}`, details);
  }
}

const LEGACY_PROTOCOL_V1 = "agent-comm/1";

interface ConnectionCommandDecision {
  messageStatus: AgentMessageStatus;
  messageError?: string;
  contact?: AgentContact;
  eventStatus?: AgentConnectionEventStatus;
  eventReason?: string;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function getTrustedPeerCandidate(store: StateStore, peerId: string): AgentPeer | null {
  const peer = store.getAgentPeer(peerId);
  if (!peer || peer.status !== "trusted") {
    return null;
  }
  return peer;
}

function assertTrustedPeerSenderBinding(
  peer: AgentPeer,
  event: TransactionEvent,
  senderAddress: Address,
  senderPubkey: string,
): void {
  const peerWalletAddress = normalizeAddress(peer.walletAddress, "peer wallet address");
  if (senderAddress !== peerWalletAddress) {
    throw new InboxProcessingError(
      "PEER_WALLET_MISMATCH",
      "Transaction sender does not match trusted peer wallet",
      {
        txHash: event.txHash,
        senderPeerId: peer.peerId,
        expected: peerWalletAddress,
        received: senderAddress,
      },
    );
  }

  if (peer.pubkey.toLowerCase() !== senderPubkey.toLowerCase()) {
    throw new InboxProcessingError("PEER_PUBKEY_MISMATCH", "Envelope senderPubkey does not match trusted peer", {
      txHash: event.txHash,
      senderPeerId: peer.peerId,
    });
  }
}

function findInboundMessage(store: StateStore, peerId: string, nonce: string): AgentMessage | null {
  return store.findAgentMessage(peerId, "inbound", nonce);
}

function parseCommand(plaintext: string): AgentCommand {
  let decoded: unknown;
  try {
    decoded = JSON.parse(plaintext);
  } catch (error) {
    const reason = toErrorMessage(error);
    throw new InboxProcessingError("INVALID_COMMAND_JSON", `Invalid command JSON: ${reason}`);
  }

  try {
    return agentCommandSchema.parse(decoded);
  } catch (error) {
    const reason = toErrorMessage(error);
    throw new InboxProcessingError("INVALID_COMMAND", `Invalid command payload: ${reason}`);
  }
}

function resolveContactForSender(
  store: StateStore,
  senderAddress: Address,
  rawSenderAddress: string,
  senderPeerId: string,
): AgentContact | null {
  const senderPeerIdValue = senderPeerId.trim();
  return (
    store.getAgentContactByIdentityWallet(senderAddress) ??
    store.getAgentContactByIdentityWallet(rawSenderAddress) ??
    store.getAgentContactByIdentityWallet(rawSenderAddress.toLowerCase()) ??
    (senderPeerIdValue.length > 0
      ? store.getAgentContactByLegacyPeerId(senderPeerIdValue)
      : null)
  );
}

function ensureTrustedPeerContact(store: StateStore, peer: AgentPeer): AgentContact {
  const existingContact =
    store.getAgentContactByIdentityWallet(peer.walletAddress) ??
    store.getAgentContactByLegacyPeerId(peer.peerId);
  const stableStatus =
    existingContact?.status === "blocked" || existingContact?.status === "revoked"
      ? existingContact.status
      : "trusted";
  return store.upsertAgentContact({
    contactId: existingContact?.contactId,
    identityWallet: peer.walletAddress,
    legacyPeerId: peer.peerId,
    displayName: existingContact?.displayName ?? peer.name,
    status: stableStatus,
    supportedProtocols: dedupeStrings([...(existingContact?.supportedProtocols ?? []), LEGACY_PROTOCOL_V1]),
    capabilityProfile: existingContact?.capabilityProfile,
    capabilities:
      existingContact?.capabilities && existingContact.capabilities.length > 0
        ? existingContact.capabilities
        : peer.capabilities,
    metadata: existingContact?.metadata,
  });
}

function hasMatchingPendingOutboundInvite(store: StateStore, contact: AgentContact): boolean {
  if (contact.status === "pending_outbound") {
    return true;
  }
  return (
    store.listAgentConnectionEvents(1, {
      contactId: contact.contactId,
      direction: "outbound",
      eventType: "connection_invite",
      eventStatus: "pending",
    }).length > 0
  );
}

function resolveInboundMessagePeerId(input: {
  trustedPeer?: AgentPeer | null;
  contact?: AgentContact;
  senderAddress: Address;
}): string {
  if (input.trustedPeer) {
    return input.trustedPeer.peerId;
  }
  if (input.contact) {
    return input.contact.legacyPeerId ?? `contact:${input.contact.contactId}`;
  }
  return `unknown:${input.senderAddress.toLowerCase()}`;
}

function persistInboundMessage(
  store: StateStore,
  input: {
    peerId: string;
    nonce: string;
    txHash: string;
    commandType: AgentCommand["type"];
    ciphertext: string;
    sentAt: string;
    receivedAt: string;
    status: AgentMessageStatus;
    error?: string;
  },
): AgentMessage {
  const existingMessage = findInboundMessage(store, input.peerId, input.nonce);
  if (existingMessage) {
    return existingMessage;
  }

  try {
    return store.insertAgentMessage({
      direction: "inbound",
      peerId: input.peerId,
      txHash: input.txHash,
      nonce: input.nonce,
      commandType: input.commandType,
      ciphertext: input.ciphertext,
      status: input.status,
      error: input.error,
      sentAt: input.sentAt,
      receivedAt: input.receivedAt,
    });
  } catch (error) {
    const reason = toErrorMessage(error);
    const duplicateMessage = findInboundMessage(store, input.peerId, input.nonce);
    if (duplicateMessage) {
      return duplicateMessage;
    }
    throw new InboxProcessingError("MESSAGE_INSERT_FAILED", `Failed to persist inbound message: ${reason}`, {
      txHash: input.txHash,
      peerId: input.peerId,
      nonce: input.nonce,
    });
  }
}

function evaluateConnectionCommand(
  store: StateStore,
  command: AgentCommand,
  contact: AgentContact | null,
  senderAddress: Address,
  senderPeerId: string,
): ConnectionCommandDecision {
  if (!isConnectionCommandType(command.type)) {
    return {
      messageStatus: "rejected",
      messageError: `unsupported control-plane command: ${command.type}`,
      contact: contact ?? undefined,
      eventStatus: "rejected",
    };
  }

  if (command.type === "connection_invite") {
    const inviteContact = contact
      ? store.upsertAgentContact({
          contactId: contact.contactId,
          identityWallet: contact.identityWallet,
          legacyPeerId: contact.legacyPeerId ?? senderPeerId,
          status: contact.status === "trusted" ? "trusted" : "pending_inbound",
          supportedProtocols: dedupeStrings([...contact.supportedProtocols, LEGACY_PROTOCOL_V1]),
          capabilityProfile: contact.capabilityProfile,
          capabilities: contact.capabilities,
          metadata: contact.metadata,
        })
      : store.upsertAgentContact({
          identityWallet: senderAddress,
          legacyPeerId: senderPeerId,
          status: "pending_inbound",
          supportedProtocols: [LEGACY_PROTOCOL_V1],
          capabilities: [],
        });

    if (inviteContact.status === "blocked" || inviteContact.status === "revoked") {
      return {
        messageStatus: "rejected",
        messageError: `connection invite ignored for ${inviteContact.status} contact`,
        contact: inviteContact,
        eventStatus: "ignored",
        eventReason: `contact_${inviteContact.status}`,
      };
    }

    return {
      messageStatus: "received",
      contact: inviteContact,
      eventStatus: "pending",
    };
  }

  if (!contact) {
    return {
      messageStatus: "rejected",
      messageError: `${command.type} rejected: no matching contact`,
      eventStatus: "rejected",
    };
  }

  if (!hasMatchingPendingOutboundInvite(store, contact)) {
    return {
      messageStatus: "rejected",
      messageError: `${command.type} rejected: no matching pending outbound invite`,
      contact,
      eventStatus: "rejected",
      eventReason: "missing_pending_outbound_invite",
    };
  }

  if (contact.status === "blocked" || contact.status === "revoked") {
    return {
      messageStatus: "rejected",
      messageError: `${command.type} rejected for ${contact.status} contact`,
      contact,
      eventStatus: "ignored",
      eventReason: `contact_${contact.status}`,
    };
  }

  if (command.type === "connection_accept") {
    const acceptedContact = store.upsertAgentContact({
      contactId: contact.contactId,
      identityWallet: contact.identityWallet,
      legacyPeerId: contact.legacyPeerId,
      status: "trusted",
      supportedProtocols: dedupeStrings([...contact.supportedProtocols, LEGACY_PROTOCOL_V1]),
      capabilityProfile: command.payload.capabilityProfile ?? contact.capabilityProfile,
      capabilities: command.payload.capabilities ?? contact.capabilities,
      metadata: contact.metadata,
    });
    return {
      messageStatus: "received",
      contact: acceptedContact,
      eventStatus: "applied",
      eventReason: command.payload.note,
    };
  }

  if (command.type === "connection_reject") {
    const rejectedContact = store.upsertAgentContact({
      contactId: contact.contactId,
      identityWallet: contact.identityWallet,
      legacyPeerId: contact.legacyPeerId,
      status: "imported",
      supportedProtocols: dedupeStrings([...contact.supportedProtocols, LEGACY_PROTOCOL_V1]),
      capabilityProfile: contact.capabilityProfile,
      capabilities: contact.capabilities,
      metadata: contact.metadata,
    });
    return {
      messageStatus: "received",
      contact: rejectedContact,
      eventStatus: "applied",
      eventReason: command.payload.reason ?? command.payload.note,
    };
  }

  const confirmedContact = store.upsertAgentContact({
    contactId: contact.contactId,
    identityWallet: contact.identityWallet,
    legacyPeerId: contact.legacyPeerId,
    status: "trusted",
    supportedProtocols: dedupeStrings([...contact.supportedProtocols, LEGACY_PROTOCOL_V1]),
    capabilityProfile: contact.capabilityProfile,
    capabilities: contact.capabilities,
    metadata: contact.metadata,
  });
  return {
    messageStatus: "received",
    contact: confirmedContact,
    eventStatus: "applied",
    eventReason: command.payload.note,
  };
}

export async function processInbox(
  options: InboxProcessorOptions,
  event: TransactionEvent,
): Promise<ProcessInboxResult> {
  const localAddress = normalizeAddress(options.wallet.getAddress(), "wallet address");
  const eventRecipient = normalizeAddress(event.to, "transaction recipient");
  if (eventRecipient !== localAddress) {
    throw new InboxProcessingError("RECIPIENT_MISMATCH", "Transaction is not addressed to this wallet", {
      txHash: event.txHash,
      expected: localAddress,
      received: eventRecipient,
    });
  }

  const envelope = withInboxError(
    "INVALID_ENVELOPE",
    "Failed to decode calldata envelope",
    { txHash: event.txHash },
    () => decodeEnvelope(event.calldata),
  );

  const envelopeRecipient = normalizeAddress(envelope.recipient, "envelope recipient");
  if (envelopeRecipient !== localAddress) {
    throw new InboxProcessingError("ENVELOPE_RECIPIENT_MISMATCH", "Envelope recipient does not match wallet", {
      txHash: event.txHash,
      expected: localAddress,
      received: envelopeRecipient,
    });
  }
  const senderAddress = normalizeAddress(event.from, "transaction sender");
  const trustedPeer = getTrustedPeerCandidate(options.store, envelope.senderPeerId);
  if (trustedPeer) {
    assertTrustedPeerSenderBinding(trustedPeer, event, senderAddress, envelope.senderPubkey);
  }

  const sharedKey = withInboxError(
    "ECDH_DERIVE_FAILED",
    "Failed to derive shared key",
    { txHash: event.txHash },
    () => deriveSharedKey(options.wallet.privateKey, envelope.senderPubkey),
  );

  const plaintext = withInboxError(
    "DECRYPT_FAILED",
    "Failed to decrypt inbound envelope",
    {
      txHash: event.txHash,
      senderPeerId: envelope.senderPeerId,
    },
    () => decrypt(envelope.ciphertext, sharedKey),
  );

  const command = parseCommand(plaintext);
  if (command.type !== envelope.command.type) {
    throw new InboxProcessingError("COMMAND_TYPE_MISMATCH", "Envelope command descriptor does not match plaintext command", {
      txHash: event.txHash,
      envelopeType: envelope.command.type,
      plaintextType: command.type,
    });
  }

  if (trustedPeer && !isConnectionCommandType(command.type)) {
    const message = persistInboundMessage(options.store, {
      peerId: trustedPeer.peerId,
      txHash: event.txHash,
      nonce: envelope.nonce,
      commandType: command.type,
      ciphertext: envelope.ciphertext,
      status: "decrypted",
      sentAt: envelope.timestamp,
      receivedAt: event.timestamp,
    });
    return {
      message,
      command,
    };
  }

  const senderContact = trustedPeer
    ? ensureTrustedPeerContact(options.store, trustedPeer)
    : resolveContactForSender(options.store, senderAddress, event.from, envelope.senderPeerId);

  if (!trustedPeer && isBusinessCommandType(command.type)) {
    const message = persistInboundMessage(options.store, {
      peerId: resolveInboundMessagePeerId({
        contact: senderContact,
        senderAddress,
      }),
      txHash: event.txHash,
      nonce: envelope.nonce,
      commandType: command.type,
      ciphertext: envelope.ciphertext,
      status: "rejected",
      error: `unknown business command rejected for untrusted sender: ${command.type}`,
      sentAt: envelope.timestamp,
      receivedAt: event.timestamp,
    });
    return {
      message,
      command,
    };
  }

  const controlPlaneDecision = evaluateConnectionCommand(
    options.store,
    command,
    senderContact,
    senderAddress,
    envelope.senderPeerId,
  );
  const message = persistInboundMessage(options.store, {
    peerId: resolveInboundMessagePeerId({
      trustedPeer,
      contact: controlPlaneDecision.contact,
      senderAddress,
    }),
    txHash: event.txHash,
    nonce: envelope.nonce,
    commandType: command.type,
    ciphertext: envelope.ciphertext,
    status: controlPlaneDecision.messageStatus,
    error: controlPlaneDecision.messageError,
    sentAt: envelope.timestamp,
    receivedAt: event.timestamp,
  });

  if (controlPlaneDecision.contact) {
    const eventType: AgentConnectionEventType =
      command.type === "connection_invite"
        ? "connection_invite"
        : command.type === "connection_accept"
          ? "connection_accept"
          : command.type === "connection_reject"
            ? "connection_reject"
            : "connection_confirm";
    options.store.upsertAgentConnectionEvent({
      contactId: controlPlaneDecision.contact.contactId,
      identityWallet: controlPlaneDecision.contact.identityWallet,
      direction: "inbound",
      eventType,
      eventStatus: controlPlaneDecision.eventStatus ?? "pending",
      messageId: message.id,
      txHash: event.txHash,
      reason: controlPlaneDecision.eventReason ?? controlPlaneDecision.messageError,
      occurredAt: event.timestamp,
      metadata: {
        senderPeerId: envelope.senderPeerId,
        trustedSender: Boolean(trustedPeer),
        envelopeVersion: envelope.version,
      },
    });
  }

  return {
    message,
    command,
  };
}
