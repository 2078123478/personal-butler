import { getAddress, type Address } from "viem";
import type { StateStore } from "../state-store";
import {
  verifySignedIdentityArtifactBundle,
  type AgentCommSignedContactCardArtifact,
  type AgentCommSignedIdentityArtifactBundle,
  type AgentCommSignedTransportBindingArtifact,
} from "./artifact-workflow";
import type { ResolvedReceiveKey } from "./local-identity";
import { decodeEnvelope } from "./calldata-codec";
import {
  getConnectionEventType,
  getPendingInviteEvent,
  normalizeOptionalStringList,
  normalizeOptionalText,
  readConnectionEventMetadataString,
  readConnectionEventMetadataStringArray,
} from "./connection-helpers";
import { decrypt, deriveSharedKey } from "./ecdh-crypto";
import type { ShadowWallet } from "./shadow-wallet";
import {
  persistSignedContactCardArtifact,
  persistSignedTransportBindingArtifact,
} from "./signed-artifact-store";
import {
  AGENT_COMM_KEX_SUITE_V2,
  agentCommandSchema,
  encryptedEnvelopeV2BodySchema,
  isBusinessCommandType,
  isConnectionCommandType,
  type AgentCommand,
  type AgentConnectionEventStatus,
  type AgentContact,
  type AgentMessage,
  type AgentMessageStatus,
  type AgentPeer,
  type EncryptedEnvelopeV2Payment,
  type X402Mode,
} from "./types";
import type { TransactionEvent } from "./tx-listener";
import { verifyX402Proof } from "./x402-adapter";

export interface InboxProcessorOptions {
  wallet: ShadowWallet;
  store: StateStore;
  expectedChainId?: number;
  receiveKeys?: ResolvedReceiveKey[];
  config?: {
    commAutoAcceptInvites?: boolean;
    x402Mode?: X402Mode;
  };
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
const UNKNOWN_INBOUND_DECRYPT_WINDOW_MS = 60_000;
const UNKNOWN_INBOUND_DECRYPT_MAX_ATTEMPTS = 5;

interface ConnectionCommandDecision {
  messageStatus: AgentMessageStatus;
  messageError?: string;
  contact?: AgentContact;
  eventStatus?: AgentConnectionEventStatus;
  eventReason?: string;
  eventMetadata?: Record<string, unknown>;
  trustOutcome?: string;
}

interface InviteContactDecision {
  status: AgentContact["status"];
  autoAccepted: boolean;
}

interface UntrustedBusinessCommandDecision {
  status: AgentMessageStatus;
  trustOutcome: string;
  error?: string;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function toNowUnixSeconds(input: string): number | undefined {
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return Math.floor(parsed / 1000);
}

function isBlockedOrRevokedStatus(
  status: AgentContact["status"] | undefined,
): status is "blocked" | "revoked" {
  return status === "blocked" || status === "revoked";
}

function getInlineCardAttachment(
  command: AgentCommand,
): AgentCommSignedIdentityArtifactBundle | undefined {
  switch (command.type) {
    case "connection_invite":
    case "connection_accept":
    case "connection_reject":
    case "connection_confirm":
      return command.payload.inlineCard;
    default:
      return undefined;
  }
}

function materializeInlineCardContact(
  store: StateStore,
  input: {
    existingContact: AgentContact | null;
    senderPeerId?: string;
    contactCard: AgentCommSignedContactCardArtifact;
    contactCardDigest: string;
    transportBinding: AgentCommSignedTransportBindingArtifact;
    transportBindingDigest: string;
  },
): AgentContact {
  const contactCardLegacyPeerId = normalizeOptionalText(input.contactCard.legacyPeerId);
  const contactByIdentity = store.getAgentContactByIdentityWallet(input.contactCard.identityWallet);
  const contactByLegacyPeerId = contactCardLegacyPeerId
    ? store.getAgentContactByLegacyPeerId(contactCardLegacyPeerId)
    : null;
  const existingContact = contactByIdentity ?? contactByLegacyPeerId ?? input.existingContact;

  const contact = store.upsertAgentContact({
    contactId: existingContact?.contactId,
    identityWallet: input.contactCard.identityWallet,
    legacyPeerId:
      existingContact?.legacyPeerId ?? contactCardLegacyPeerId ?? normalizeOptionalText(input.senderPeerId),
    displayName:
      existingContact?.displayName ?? normalizeOptionalText(input.contactCard.displayName),
    handle: existingContact?.handle ?? normalizeOptionalText(input.contactCard.handle),
    status: existingContact?.status ?? "imported",
    supportedProtocols:
      normalizeOptionalStringList([
        ...(existingContact?.supportedProtocols ?? []),
        ...input.contactCard.protocols,
      ]) ?? [LEGACY_PROTOCOL_V1],
    capabilityProfile:
      existingContact?.capabilityProfile ??
      normalizeOptionalText(input.contactCard.defaults.capabilityProfile),
    capabilities:
      existingContact?.capabilities && existingContact.capabilities.length > 0
        ? existingContact.capabilities
        : normalizeOptionalStringList(input.contactCard.defaults.capabilities) ?? [],
    metadata: {
      ...(existingContact?.metadata ?? {}),
      contactCardDigest: input.contactCardDigest,
    },
  });

  store.upsertAgentTransportEndpoint({
    contactId: contact.contactId,
    identityWallet: contact.identityWallet,
    chainId: input.transportBinding.chainId,
    receiveAddress: input.transportBinding.receiveAddress,
    pubkey: input.transportBinding.pubkey,
    keyId: input.transportBinding.keyId,
    bindingDigest: input.transportBindingDigest,
    endpointStatus: "active",
    source: "inline_attachment",
  });

  return contact;
}

interface InlineCardAttachmentDecision {
  contact: AgentContact | null;
  metadata?: Record<string, unknown>;
  rejectReason?: string;
  trustOutcome?: string;
}

async function evaluateInlineCardAttachment(
  store: StateStore,
  input: {
    command: AgentCommand;
    existingContact: AgentContact | null;
    senderAddress: Address;
    senderPeerId?: string;
    expectedChainId?: number;
    occurredAt: string;
  },
): Promise<InlineCardAttachmentDecision> {
  const inlineCard = getInlineCardAttachment(input.command);
  if (!inlineCard) {
    return {
      contact: input.existingContact,
    };
  }

  const verification = await verifySignedIdentityArtifactBundle(inlineCard, {
    expectedChainId: input.expectedChainId,
    nowUnixSeconds: toNowUnixSeconds(input.occurredAt),
  });
  const verificationError =
    verification.errors.length > 0 ? verification.errors.join("; ") : "invalid inline card";

  if (verification.contactCard) {
    persistSignedContactCardArtifact(store, verification.contactCard.artifact, {
      digest: verification.contactCard.digest,
      source: "inline_attachment",
      verificationStatus: verification.contactCard.ok ? "verified" : "invalid",
      verificationError: verification.contactCard.ok ? undefined : verificationError,
    });
  }
  if (verification.transportBinding) {
    persistSignedTransportBindingArtifact(store, verification.transportBinding.artifact, {
      digest: verification.transportBinding.digest,
      source: "inline_attachment",
      verificationStatus: verification.transportBinding.ok ? "verified" : "invalid",
      verificationError: verification.transportBinding.ok ? undefined : verificationError,
    });
  }

  const baseMetadata: Record<string, unknown> = {
    inlineCardAttached: true,
    ...(verification.contactCard
      ? { inlineCardContactCardDigest: verification.contactCard.digest }
      : {}),
    ...(verification.transportBinding
      ? { inlineCardTransportBindingDigest: verification.transportBinding.digest }
      : {}),
  };

  if (!verification.ok || !verification.contactCard || !verification.transportBinding) {
    return {
      contact: input.existingContact,
      metadata: {
        ...baseMetadata,
        inlineCardStatus: "invalid",
      },
      rejectReason: verificationError,
      trustOutcome: "inline_card_invalid",
    };
  }

  const transportAddress = normalizeAddress(
    verification.transportBinding.artifact.receiveAddress,
    "inline card transport address",
  );
  if (transportAddress !== input.senderAddress) {
    const mismatchReason =
      "inline card transport address does not match transaction sender";
    return {
      contact: input.existingContact,
      metadata: {
        ...baseMetadata,
        inlineCardStatus: "invalid",
        inlineCardIdentityWallet: verification.contactCard.artifact.identityWallet,
        inlineCardTransportAddress: verification.transportBinding.artifact.receiveAddress,
      },
      rejectReason: mismatchReason,
      trustOutcome: "inline_card_sender_mismatch",
    };
  }

  const importedContact = materializeInlineCardContact(store, {
    existingContact: input.existingContact,
    senderPeerId: input.senderPeerId,
    contactCard: verification.contactCard.artifact,
    contactCardDigest: verification.contactCard.digest,
    transportBinding: verification.transportBinding.artifact,
    transportBindingDigest: verification.transportBinding.digest,
  });
  return {
    contact: importedContact,
    metadata: {
      ...baseMetadata,
      inlineCardStatus: "verified",
      inlineCardIdentityWallet: verification.contactCard.artifact.identityWallet,
      inlineCardTransportAddress: verification.transportBinding.artifact.receiveAddress,
    },
  };
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

function getReceiveKeys(options: InboxProcessorOptions): ResolvedReceiveKey[] {
  if (options.receiveKeys && options.receiveKeys.length > 0) {
    return options.receiveKeys;
  }

  return [
    {
      walletAlias: "active",
      wallet: options.wallet,
      walletAddress: options.wallet.getAddress(),
      pubkey: options.wallet.getPublicKey(),
      status: "active",
    },
  ];
}

function resolveReceiveKeyByAddress(
  options: InboxProcessorOptions,
  recipientAddress: Address,
): ResolvedReceiveKey | undefined {
  return getReceiveKeys(options).find(
    (entry) => normalizeAddress(entry.walletAddress, "local receive address") === recipientAddress,
  );
}

function resolveReceiveKeyByKeyId(
  options: InboxProcessorOptions,
  recipientKeyId: string,
): ResolvedReceiveKey | undefined {
  return getReceiveKeys(options).find((entry) => entry.transportKeyId === recipientKeyId);
}

function findInboundMessage(store: StateStore, peerId: string, nonce: string): AgentMessage | null {
  return store.findAgentMessage(peerId, "inbound", nonce);
}

function findInboundMessageByMsgId(store: StateStore, msgId: string): AgentMessage | null {
  return store.findAgentMessageByMsgId("inbound", msgId);
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

function parseV2Body(plaintext: string): {
  msgId: string;
  sentAt: string;
  sender: {
    identityWallet: string;
    transportAddress: string;
    cardDigest?: string;
  };
  command: AgentCommand;
  payment?: EncryptedEnvelopeV2Payment;
  attachments?: {
    inlineCard?: AgentCommSignedIdentityArtifactBundle;
  };
} {
  let decoded: unknown;
  try {
    decoded = JSON.parse(plaintext);
  } catch (error) {
    const reason = toErrorMessage(error);
    throw new InboxProcessingError("INVALID_COMMAND_JSON", `Invalid command JSON: ${reason}`);
  }

  try {
    const parsed = encryptedEnvelopeV2BodySchema.parse(decoded);
    const command = agentCommandSchema.parse({
      type: parsed.command.type,
      payload: parsed.command.payload,
    });
    return {
      msgId: parsed.msgId,
      sentAt: parsed.sentAt,
      sender: parsed.sender,
      command,
      payment: parsed.payment,
      attachments: parsed.attachments,
    };
  } catch (error) {
    const reason = toErrorMessage(error);
    throw new InboxProcessingError("INVALID_COMMAND", `Invalid command payload: ${reason}`);
  }
}

function withInlineCardAttachment(
  command: AgentCommand,
  inlineCard: AgentCommSignedIdentityArtifactBundle | undefined,
): AgentCommand {
  if (!inlineCard) {
    return command;
  }

  switch (command.type) {
    case "connection_invite":
      return {
        ...command,
        payload: {
          ...command.payload,
          inlineCard,
        },
      };
    case "connection_accept":
      return {
        ...command,
        payload: {
          ...command.payload,
          inlineCard,
        },
      };
    case "connection_reject":
      return {
        ...command,
        payload: {
          ...command.payload,
          inlineCard,
        },
      };
    case "connection_confirm":
      return {
        ...command,
        payload: {
          ...command.payload,
          inlineCard,
        },
      };
    default:
      return command;
  }
}

function assertAuthorizedSenderTransport(
  store: StateStore,
  input: {
    contact: AgentContact;
    senderAddress: Address;
    senderIdentityWallet: string;
    senderCardDigest?: string;
  },
): void {
  const endpoint = store.listAgentTransportEndpoints(1, {
    contactId: input.contact.contactId,
    receiveAddress: input.senderAddress,
    endpointStatus: "active",
  })[0];
  if (!endpoint) {
    throw new InboxProcessingError(
      "UNAUTHORIZED_TRANSPORT",
      "Transaction sender is not an active authorized transport endpoint",
      {
        identityWallet: input.senderIdentityWallet,
        senderAddress: input.senderAddress,
      },
    );
  }
  if (!endpoint.bindingDigest) {
    throw new InboxProcessingError(
      "MISSING_TRANSPORT_BINDING",
      "Transport endpoint is missing a verified LIW binding",
      {
        identityWallet: input.senderIdentityWallet,
        senderAddress: input.senderAddress,
      },
    );
  }

  const bindingArtifact = store.getAgentSignedArtifact(endpoint.bindingDigest);
  if (!bindingArtifact || bindingArtifact.verificationStatus !== "verified") {
    throw new InboxProcessingError(
      "INVALID_TRANSPORT_BINDING",
      "Transport endpoint binding is not verified",
      {
        identityWallet: input.senderIdentityWallet,
        senderAddress: input.senderAddress,
        bindingDigest: endpoint.bindingDigest,
      },
    );
  }

  const bindingStatus = store.getAgentArtifactStatus(endpoint.bindingDigest);
  if (bindingStatus && bindingStatus.status === "revoked") {
    throw new InboxProcessingError(
      "REVOKED_TRANSPORT_BINDING",
      "Transport endpoint binding is revoked",
      {
        identityWallet: input.senderIdentityWallet,
        senderAddress: input.senderAddress,
        bindingDigest: endpoint.bindingDigest,
      },
    );
  }

  if (input.senderCardDigest) {
    const contactCardArtifact = store.getAgentSignedArtifact(input.senderCardDigest);
    if (
      !contactCardArtifact
      || contactCardArtifact.artifactType !== "ContactCard"
      || contactCardArtifact.verificationStatus !== "verified"
    ) {
      throw new InboxProcessingError(
        "INVALID_CONTACT_CARD_DIGEST",
        "Sender card digest does not resolve to a verified contact card",
        {
          identityWallet: input.senderIdentityWallet,
          senderAddress: input.senderAddress,
          cardDigest: input.senderCardDigest,
        },
      );
    }

    const cardStatus = store.getAgentArtifactStatus(input.senderCardDigest);
    if (cardStatus?.status === "revoked") {
      throw new InboxProcessingError(
        "REVOKED_CONTACT_CARD",
        "Sender contact card is revoked",
        {
          identityWallet: input.senderIdentityWallet,
          senderAddress: input.senderAddress,
          cardDigest: input.senderCardDigest,
        },
      );
    }
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
  const existingStatus = existingContact?.status;
  const stableStatus = isBlockedOrRevokedStatus(existingStatus) ? existingStatus : "trusted";
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

function hasMatchingPendingConnectionState(
  store: StateStore,
  command: AgentCommand,
  contact: AgentContact,
): boolean {
  if (command.type === "connection_confirm") {
    return contact.status === "trusted" || hasMatchingPendingOutboundInvite(store, contact);
  }
  return hasMatchingPendingOutboundInvite(store, contact);
}

function toTimestampMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function countRecentInboundMessagesForSender(
  store: StateStore,
  senderAddress: Address,
  eventTimestampMs: number,
): number {
  const normalizedSender = senderAddress.toLowerCase();
  const windowStartMs = eventTimestampMs - UNKNOWN_INBOUND_DECRYPT_WINDOW_MS;
  return store
    .listAgentMessages(1000, {
      direction: "inbound",
    })
    .filter((message) => message.transportAddress?.toLowerCase() === normalizedSender)
    .filter((message) => {
      const messageTimestampMs = toTimestampMs(message.receivedAt ?? message.createdAt);
      return messageTimestampMs !== null && messageTimestampMs >= windowStartMs;
    }).length;
}

function enforceUnknownInboundRateLimit(
  store: StateStore,
  senderAddress: Address,
  eventTimestamp: string,
): void {
  const eventTimestampMs = toTimestampMs(eventTimestamp) ?? Date.now();
  const recentCount = countRecentInboundMessagesForSender(store, senderAddress, eventTimestampMs);
  if (recentCount < UNKNOWN_INBOUND_DECRYPT_MAX_ATTEMPTS) {
    return;
  }

  throw new InboxProcessingError(
    "UNKNOWN_INBOUND_RATE_LIMITED",
    "Unknown inbound decrypt path rate limit exceeded",
    {
      senderAddress,
      recentCount,
      windowMs: UNKNOWN_INBOUND_DECRYPT_WINDOW_MS,
    },
  );
}

function extractConnectionEventMetadata(command: AgentCommand): Record<string, unknown> {
  if (!isConnectionCommandType(command.type)) {
    return {};
  }

  switch (command.type) {
    case "connection_invite":
      return {
        ...(command.payload.requestedProfile
          ? { requestedProfile: command.payload.requestedProfile }
          : {}),
        ...(command.payload.requestedCapabilities
          ? { requestedCapabilities: command.payload.requestedCapabilities }
          : {}),
        ...(command.payload.note ? { note: command.payload.note } : {}),
      };
    case "connection_accept":
      return {
        ...(command.payload.capabilityProfile
          ? { capabilityProfile: command.payload.capabilityProfile }
          : {}),
        ...(command.payload.capabilities ? { capabilities: command.payload.capabilities } : {}),
        ...(command.payload.note ? { note: command.payload.note } : {}),
      };
    case "connection_reject":
      return {
        ...(command.payload.reason ? { reason: command.payload.reason } : {}),
        ...(command.payload.note ? { note: command.payload.note } : {}),
      };
    case "connection_confirm":
      return {
        ...(command.payload.note ? { note: command.payload.note } : {}),
      };
  }
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
    envelopeVersion: number;
    msgId?: string;
    contactId?: string;
    identityWallet?: string;
    transportAddress: string;
    trustOutcome?: string;
    payment?: EncryptedEnvelopeV2Payment;
    decryptedCommandType?: AgentCommand["type"];
    ciphertext: string;
    sentAt: string;
    receivedAt: string;
    status: AgentMessageStatus;
    error?: string;
  },
): AgentMessage {
  if (input.msgId) {
    const existingByMsgId = findInboundMessageByMsgId(store, input.msgId);
    if (existingByMsgId) {
      return existingByMsgId;
    }
  }

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
      envelopeVersion: input.envelopeVersion,
      msgId: input.msgId,
      contactId: input.contactId,
      identityWallet: input.identityWallet,
      transportAddress: input.transportAddress,
      trustOutcome: input.trustOutcome,
      payment: input.payment,
      decryptedCommandType: input.decryptedCommandType,
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
    if (input.msgId) {
      const duplicateByMsgId = findInboundMessageByMsgId(store, input.msgId);
      if (duplicateByMsgId) {
        return duplicateByMsgId;
      }
    }
    throw new InboxProcessingError("MESSAGE_INSERT_FAILED", `Failed to persist inbound message: ${reason}`, {
      txHash: input.txHash,
      peerId: input.peerId,
      nonce: input.nonce,
      msgId: input.msgId,
    });
  }
}

function withLegacyProtocol(supportedProtocols: string[]): string[] {
  return dedupeStrings([...supportedProtocols, LEGACY_PROTOCOL_V1]);
}

function upsertConnectionContact(
  store: StateStore,
  contact: AgentContact,
  patch: {
    status: AgentContact["status"];
    legacyPeerId?: string;
    capabilityProfile?: string;
    capabilities?: string[];
  },
): AgentContact {
  return store.upsertAgentContact({
    contactId: contact.contactId,
    identityWallet: contact.identityWallet,
    legacyPeerId: patch.legacyPeerId ?? contact.legacyPeerId,
    status: patch.status,
    supportedProtocols: withLegacyProtocol(contact.supportedProtocols),
    capabilityProfile: patch.capabilityProfile ?? contact.capabilityProfile,
    capabilities: patch.capabilities ?? contact.capabilities,
    metadata: contact.metadata,
  });
}

function upsertInviteContact(
  store: StateStore,
  contact: AgentContact | null,
  senderAddress: Address,
  senderPeerId: string | undefined,
  inviteStatus: InviteContactDecision["status"],
): AgentContact {
  if (contact) {
    return upsertConnectionContact(store, contact, {
      legacyPeerId: contact.legacyPeerId ?? senderPeerId,
      status: inviteStatus,
    });
  }

  return store.upsertAgentContact({
    identityWallet: senderAddress,
    legacyPeerId: senderPeerId,
    status: inviteStatus,
    supportedProtocols: [LEGACY_PROTOCOL_V1],
    capabilities: [],
  });
}

function resolveInviteContactDecision(
  contact: AgentContact | null,
  autoAcceptInvites: boolean,
): InviteContactDecision {
  const contactStatus = contact?.status;

  if (isBlockedOrRevokedStatus(contactStatus)) {
    return {
      status: contactStatus,
      autoAccepted: false,
    };
  }

  if (contactStatus === "trusted") {
    return {
      status: contactStatus,
      autoAccepted: false,
    };
  }

  if (!autoAcceptInvites) {
    return {
      status: "pending_inbound",
      autoAccepted: false,
    };
  }

  return {
    status: "trusted",
    autoAccepted: true,
  };
}

function persistBusinessCommandMessage(
  store: StateStore,
  input: {
    peerId: string;
    txHash: string;
    nonce: string;
    msgId?: string;
    command: AgentCommand;
    envelopeVersion: number;
    contactId?: string;
    identityWallet?: string;
    transportAddress: string;
    ciphertext: string;
    sentAt: string;
    receivedAt: string;
    trustedSender: boolean;
    payment?: EncryptedEnvelopeV2Payment;
    untrustedDecision?: UntrustedBusinessCommandDecision;
  },
): AgentMessage {
  const defaultUntrustedDecision: UntrustedBusinessCommandDecision = input.payment
    ? {
        status: "paid_pending",
        trustOutcome: "paid_pending",
      }
    : {
        status: "rejected",
        trustOutcome: "unknown_business_rejected",
        error: `unknown business command rejected for untrusted sender: ${input.command.type}`,
      };
  const untrustedDecision = input.untrustedDecision ?? defaultUntrustedDecision;

  return persistInboundMessage(store, {
    peerId: input.peerId,
    txHash: input.txHash,
    nonce: input.nonce,
    msgId: input.msgId,
    commandType: input.command.type,
    envelopeVersion: input.envelopeVersion,
    contactId: input.contactId,
    identityWallet: input.identityWallet,
    transportAddress: input.transportAddress,
    trustOutcome: input.trustedSender ? "trusted_sender" : untrustedDecision.trustOutcome,
    payment: input.payment,
    decryptedCommandType: input.command.type,
    ciphertext: input.ciphertext,
    status: input.trustedSender ? "decrypted" : untrustedDecision.status,
    error: input.trustedSender ? undefined : untrustedDecision.error,
    sentAt: input.sentAt,
    receivedAt: input.receivedAt,
  });
}

function resolveX402Mode(options: InboxProcessorOptions): X402Mode {
  return options.config?.x402Mode ?? "disabled";
}

function rejectUnknownBusinessCommand(commandType: AgentCommand["type"]): UntrustedBusinessCommandDecision {
  return {
    status: "rejected",
    trustOutcome: "unknown_business_rejected",
    error: `unknown business command rejected for untrusted sender: ${commandType}`,
  };
}

function rejectForX402Failure(error: string): UntrustedBusinessCommandDecision {
  return {
    status: "rejected",
    trustOutcome: "x402_enforce_rejected",
    error: `x402 validation failed (enforce): ${error}`,
  };
}

function paidPendingObserveWithX402Error(error: string): UntrustedBusinessCommandDecision {
  return {
    status: "paid_pending",
    trustOutcome: "paid_pending",
    error: `x402 validation failed (observe): ${error}`,
  };
}

function resolveX402FailureDecision(
  mode: X402Mode,
  error: string,
): UntrustedBusinessCommandDecision {
  if (mode === "enforce") {
    return rejectForX402Failure(error);
  }
  return paidPendingObserveWithX402Error(error);
}

async function evaluateUntrustedBusinessCommandDecision(
  options: InboxProcessorOptions,
  input: {
    commandType: AgentCommand["type"];
    payment?: EncryptedEnvelopeV2Payment;
    localPayee: Address;
    occurredAt: string;
  },
): Promise<UntrustedBusinessCommandDecision> {
  if (!input.payment) {
    return rejectUnknownBusinessCommand(input.commandType);
  }

  const x402Mode = resolveX402Mode(options);
  if (x402Mode === "disabled") {
    return {
      status: "paid_pending",
      trustOutcome: "paid_pending",
    };
  }

  if (!input.payment.proof) {
    return resolveX402FailureDecision(x402Mode, "missing x402 proof");
  }

  const verification = await verifyX402Proof(
    {
      mode: x402Mode,
      store: options.store,
      localPayees: [input.localPayee],
      expectedPayment: {
        asset: input.payment.asset,
        amount: input.payment.amount,
      },
      now: new Date(input.occurredAt),
    },
    input.payment.proof,
  );

  if (verification.valid) {
    return {
      status: "paid_pending",
      trustOutcome: "paid_pending",
    };
  }

  const reason = verification.error ?? "invalid x402 proof";
  return resolveX402FailureDecision(x402Mode, reason);
}

function recordInboundConnectionEvent(
  store: StateStore,
  input: {
    command: AgentCommand;
    contact: AgentContact;
    messageId: string;
    txHash: string;
    occurredAt: string;
    eventStatus?: AgentConnectionEventStatus;
    eventReason?: string;
    eventMetadata?: Record<string, unknown>;
    trustedSender: boolean;
    envelopeVersion: number;
    senderPeerId?: string;
    senderIdentityWallet?: string;
    recipientKeyId?: string;
  },
): void {
  const eventType = getConnectionEventType(input.command);
  if (!eventType) {
    return;
  }

  store.upsertAgentConnectionEvent({
    contactId: input.contact.contactId,
    identityWallet: input.contact.identityWallet,
    direction: "inbound",
    eventType,
    eventStatus: input.eventStatus ?? "pending",
    messageId: input.messageId,
    txHash: input.txHash,
    reason: input.eventReason,
    occurredAt: input.occurredAt,
    metadata: {
      ...(input.eventMetadata ?? {}),
      ...(input.senderPeerId ? { senderPeerId: input.senderPeerId } : {}),
      ...(input.senderIdentityWallet ? { senderIdentityWallet: input.senderIdentityWallet } : {}),
      trustedSender: input.trustedSender,
      envelopeVersion: input.envelopeVersion,
      ...(input.recipientKeyId ? { recipientKeyId: input.recipientKeyId } : {}),
    },
  });
}

async function evaluateConnectionCommand(
  store: StateStore,
  command: AgentCommand,
  contact: AgentContact | null,
  senderAddress: Address,
  senderPeerId: string | undefined,
  expectedChainId: number | undefined,
  occurredAt: string,
  autoAcceptInvites = false,
  inlineCardDecisionOverride?: InlineCardAttachmentDecision,
): Promise<ConnectionCommandDecision> {
  const inlineCardDecision =
    inlineCardDecisionOverride
    ?? await evaluateInlineCardAttachment(store, {
      command,
      existingContact: contact,
      senderAddress,
      senderPeerId,
      expectedChainId,
      occurredAt,
    });
  const resolvedContact = inlineCardDecision.contact;
  const eventMetadata = {
    ...extractConnectionEventMetadata(command),
    ...(inlineCardDecision.metadata ?? {}),
  };

  if (!isConnectionCommandType(command.type)) {
    return {
      messageStatus: "rejected",
      messageError: `unsupported control-plane command: ${command.type}`,
      contact: resolvedContact ?? undefined,
      eventStatus: "rejected",
      eventMetadata,
      trustOutcome: "unsupported_control_plane",
    };
  }

  if (inlineCardDecision.rejectReason) {
    return {
      messageStatus: "rejected",
      messageError: `${command.type} rejected: ${inlineCardDecision.rejectReason}`,
      contact: resolvedContact ?? undefined,
      eventStatus: "rejected",
      eventReason: "invalid_inline_card",
      eventMetadata,
      trustOutcome: inlineCardDecision.trustOutcome ?? "inline_card_invalid",
    };
  }

  if (command.type === "connection_invite") {
    const inviteDecision = resolveInviteContactDecision(resolvedContact, autoAcceptInvites);
    const inviteContact = upsertInviteContact(
      store,
      resolvedContact,
      senderAddress,
      senderPeerId,
      inviteDecision.status,
    );

    if (isBlockedOrRevokedStatus(inviteContact.status)) {
      return {
        messageStatus: "rejected",
        messageError: `connection invite ignored for ${inviteContact.status} contact`,
        contact: inviteContact,
        eventStatus: "ignored",
        eventReason: `contact_${inviteContact.status}`,
        eventMetadata,
        trustOutcome: `contact_${inviteContact.status}`,
      };
    }

    return {
      messageStatus: "received",
      contact: inviteContact,
      eventStatus: inviteDecision.autoAccepted ? "applied" : "pending",
      eventMetadata,
      trustOutcome: inviteDecision.autoAccepted ? "trusted" : "pending_inbound",
    };
  }

  if (!resolvedContact) {
    return {
      messageStatus: "rejected",
      messageError: `${command.type} rejected: no matching contact`,
      eventStatus: "rejected",
      eventMetadata,
      trustOutcome: "missing_contact",
    };
  }

  if (!hasMatchingPendingConnectionState(store, command, resolvedContact)) {
    const missingPendingState =
      command.type === "connection_confirm"
        ? {
            message: `${command.type} rejected: no matching pending connection state`,
            reason: "missing_pending_connection_state",
          }
        : {
            message: `${command.type} rejected: no matching pending outbound invite`,
            reason: "missing_pending_outbound_invite",
          };
    return {
      messageStatus: "rejected",
      messageError: missingPendingState.message,
      contact: resolvedContact,
      eventStatus: "rejected",
      eventReason: missingPendingState.reason,
      eventMetadata,
      trustOutcome: missingPendingState.reason,
    };
  }

  if (isBlockedOrRevokedStatus(resolvedContact.status)) {
    return {
      messageStatus: "rejected",
      messageError: `${command.type} rejected for ${resolvedContact.status} contact`,
      contact: resolvedContact,
      eventStatus: "ignored",
      eventReason: `contact_${resolvedContact.status}`,
      eventMetadata,
      trustOutcome: `contact_${resolvedContact.status}`,
    };
  }

  if (command.type === "connection_accept") {
    const pendingInvite = getPendingInviteEvent(store, resolvedContact.contactId, "outbound");
    const grantedCapabilityProfile =
      command.payload.capabilityProfile ??
      readConnectionEventMetadataString(pendingInvite?.metadata, "requestedProfile") ??
      resolvedContact.capabilityProfile;
    const grantedCapabilities =
      command.payload.capabilities ??
      readConnectionEventMetadataStringArray(pendingInvite?.metadata, "requestedCapabilities") ??
      resolvedContact.capabilities;
    const acceptedContact = upsertConnectionContact(store, resolvedContact, {
      status: "trusted",
      capabilityProfile: grantedCapabilityProfile,
      capabilities: grantedCapabilities,
    });
    return {
      messageStatus: "received",
      contact: acceptedContact,
      eventStatus: "applied",
      eventReason: command.payload.note,
      eventMetadata: {
        ...eventMetadata,
        ...(grantedCapabilityProfile ? { capabilityProfile: grantedCapabilityProfile } : {}),
        capabilities: grantedCapabilities,
      },
      trustOutcome: "trusted",
    };
  }

  if (command.type === "connection_reject") {
    const rejectedContact = upsertConnectionContact(store, resolvedContact, {
      status: "imported",
    });
    return {
      messageStatus: "received",
      contact: rejectedContact,
      eventStatus: "applied",
      eventReason: command.payload.reason ?? command.payload.note,
      eventMetadata,
      trustOutcome: "rejected",
    };
  }

  const confirmedContact = upsertConnectionContact(store, resolvedContact, {
    status: "trusted",
  });
  const confirmNote = command.type === "connection_confirm" ? command.payload.note : undefined;
  return {
    messageStatus: "received",
    contact: confirmedContact,
    eventStatus: "applied",
    eventReason: confirmNote,
    eventMetadata,
    trustOutcome: "trusted",
  };
}

async function processInboxV1(
  options: InboxProcessorOptions,
  event: TransactionEvent,
  localReceiveKey: ResolvedReceiveKey,
  envelope: ReturnType<typeof decodeEnvelope> & { version: 1 },
): Promise<ProcessInboxResult> {
  const localAddress = normalizeAddress(localReceiveKey.walletAddress, "wallet address");
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
  const senderContact = trustedPeer
    ? ensureTrustedPeerContact(options.store, trustedPeer)
    : resolveContactForSender(options.store, senderAddress, event.from, envelope.senderPeerId);
  if (!trustedPeer && senderContact?.status !== "trusted") {
    enforceUnknownInboundRateLimit(options.store, senderAddress, event.timestamp);
  }

  const sharedKey = withInboxError(
    "ECDH_DERIVE_FAILED",
    "Failed to derive shared key",
    { txHash: event.txHash },
    () => deriveSharedKey(localReceiveKey.wallet.privateKey, envelope.senderPubkey),
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
    const message = persistBusinessCommandMessage(options.store, {
      peerId: trustedPeer.peerId,
      txHash: event.txHash,
      nonce: envelope.nonce,
      command,
      envelopeVersion: envelope.version,
      contactId: senderContact?.contactId,
      identityWallet: senderContact?.identityWallet,
      transportAddress: senderAddress,
      ciphertext: envelope.ciphertext,
      sentAt: envelope.timestamp,
      receivedAt: event.timestamp,
      trustedSender: true,
    });
    return {
      message,
      command,
    };
  }

  if (!trustedPeer && isBusinessCommandType(command.type)) {
    const message = persistBusinessCommandMessage(options.store, {
      peerId: resolveInboundMessagePeerId({
        contact: senderContact ?? undefined,
        senderAddress,
      }),
      txHash: event.txHash,
      nonce: envelope.nonce,
      command,
      envelopeVersion: envelope.version,
      contactId: senderContact?.contactId,
      identityWallet: senderContact?.identityWallet,
      transportAddress: senderAddress,
      ciphertext: envelope.ciphertext,
      sentAt: envelope.timestamp,
      receivedAt: event.timestamp,
      trustedSender: false,
    });
    return {
      message,
      command,
    };
  }

  const controlPlaneDecision = await evaluateConnectionCommand(
    options.store,
    command,
    senderContact,
    senderAddress,
    envelope.senderPeerId,
    options.expectedChainId,
    event.timestamp,
    options.config?.commAutoAcceptInvites,
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
    envelopeVersion: envelope.version,
    contactId: controlPlaneDecision.contact?.contactId ?? senderContact?.contactId,
    identityWallet: controlPlaneDecision.contact?.identityWallet ?? senderContact?.identityWallet,
    transportAddress: senderAddress,
    trustOutcome: controlPlaneDecision.trustOutcome,
    decryptedCommandType: command.type,
    ciphertext: envelope.ciphertext,
    status: controlPlaneDecision.messageStatus,
    error: controlPlaneDecision.messageError,
    sentAt: envelope.timestamp,
    receivedAt: event.timestamp,
  });

  if (controlPlaneDecision.contact) {
    recordInboundConnectionEvent(options.store, {
      command,
      contact: controlPlaneDecision.contact,
      messageId: message.id,
      txHash: event.txHash,
      occurredAt: event.timestamp,
      eventStatus: controlPlaneDecision.eventStatus,
      eventReason: controlPlaneDecision.eventReason ?? controlPlaneDecision.messageError,
      eventMetadata: controlPlaneDecision.eventMetadata,
      trustedSender: Boolean(trustedPeer),
      envelopeVersion: envelope.version,
      senderPeerId: envelope.senderPeerId,
    });
  }

  return {
    message,
    command,
  };
}

async function processInboxV2(
  options: InboxProcessorOptions,
  event: TransactionEvent,
  _localReceiveKey: ResolvedReceiveKey,
  envelope: ReturnType<typeof decodeEnvelope> & { version: 2 },
): Promise<ProcessInboxResult> {
  if (envelope.kex.suite !== AGENT_COMM_KEX_SUITE_V2) {
    throw new InboxProcessingError("UNSUPPORTED_KEX_SUITE", "Unsupported agent-comm v2 key exchange suite", {
      txHash: event.txHash,
      suite: envelope.kex.suite,
    });
  }

  const resolvedByKeyId = resolveReceiveKeyByKeyId(options, envelope.kex.recipientKeyId);
  if (!resolvedByKeyId) {
    throw new InboxProcessingError(
      "UNKNOWN_RECIPIENT_KEY",
      "No local receive key matches envelope recipientKeyId",
      {
        txHash: event.txHash,
        recipientKeyId: envelope.kex.recipientKeyId,
      },
    );
  }

  const eventRecipient = normalizeAddress(event.to, "transaction recipient");
  const keyRecipient = normalizeAddress(resolvedByKeyId.walletAddress, "local receive address");
  if (eventRecipient != keyRecipient) {
    throw new InboxProcessingError(
      "RECIPIENT_KEY_MISMATCH",
      "Transaction recipient does not match the local key selected by recipientKeyId",
      {
        txHash: event.txHash,
        expected: keyRecipient,
        received: eventRecipient,
        recipientKeyId: envelope.kex.recipientKeyId,
      },
    );
  }

  const senderAddress = normalizeAddress(event.from, "transaction sender");
  const sharedKey = withInboxError(
    "ECDH_DERIVE_FAILED",
    "Failed to derive shared key",
    { txHash: event.txHash, recipientKeyId: envelope.kex.recipientKeyId },
    () => deriveSharedKey(resolvedByKeyId.wallet.privateKey, envelope.kex.ephemeralPubkey),
  );
  const plaintext = withInboxError(
    "DECRYPT_FAILED",
    "Failed to decrypt inbound envelope",
    { txHash: event.txHash, recipientKeyId: envelope.kex.recipientKeyId },
    () => decrypt(envelope.ciphertext, sharedKey),
  );
  const body = parseV2Body(plaintext);
  const senderTransportAddress = normalizeAddress(body.sender.transportAddress, "sender transport address");
  if (senderTransportAddress !== senderAddress) {
    throw new InboxProcessingError(
      "SENDER_TRANSPORT_MISMATCH",
      "Decrypted sender transportAddress does not match transaction sender",
      {
        txHash: event.txHash,
        expected: senderAddress,
        received: senderTransportAddress,
      },
    );
  }

  const existingContact = options.store.getAgentContactByIdentityWallet(body.sender.identityWallet);
  if (!existingContact || existingContact.status !== "trusted") {
    enforceUnknownInboundRateLimit(options.store, senderAddress, event.timestamp);
  }

  const command = withInlineCardAttachment(body.command, body.attachments?.inlineCard);
  const inlineCardDecision = await evaluateInlineCardAttachment(options.store, {
    command,
    existingContact,
    senderAddress,
    senderPeerId: existingContact?.legacyPeerId,
    expectedChainId: options.expectedChainId,
    occurredAt: event.timestamp,
  });
  const resolvedContact = inlineCardDecision.contact ?? existingContact;

  if (!resolvedContact && command.type === "connection_invite" && !body.attachments?.inlineCard) {
    const message = persistInboundMessage(options.store, {
      peerId: resolveInboundMessagePeerId({ senderAddress }),
      txHash: event.txHash,
      nonce: body.msgId,
      msgId: body.msgId,
      commandType: command.type,
      envelopeVersion: envelope.version,
      identityWallet: body.sender.identityWallet,
      transportAddress: senderAddress,
      trustOutcome: "missing_inline_card",
      decryptedCommandType: command.type,
      ciphertext: envelope.ciphertext,
      status: "rejected",
      error: "connection_invite rejected: missing inline card for unknown v2 sender",
      sentAt: body.sentAt,
      receivedAt: event.timestamp,
    });
    return { message, command };
  }

  if (resolvedContact) {
    assertAuthorizedSenderTransport(options.store, {
      contact: resolvedContact,
      senderAddress,
      senderIdentityWallet: body.sender.identityWallet,
      senderCardDigest: body.sender.cardDigest,
    });
  }

  if (isBusinessCommandType(command.type)) {
    const trustedSender = resolvedContact?.status === "trusted";
    const untrustedDecision = trustedSender
      ? undefined
      : await evaluateUntrustedBusinessCommandDecision(options, {
          commandType: command.type,
          payment: body.payment,
          localPayee: keyRecipient,
          occurredAt: event.timestamp,
        });
    const message = persistBusinessCommandMessage(options.store, {
      peerId: resolveInboundMessagePeerId({
        contact: resolvedContact ?? undefined,
        senderAddress,
      }),
      txHash: event.txHash,
      nonce: body.msgId,
      msgId: body.msgId,
      command,
      envelopeVersion: envelope.version,
      contactId: resolvedContact?.contactId,
      identityWallet: body.sender.identityWallet,
      transportAddress: senderAddress,
      ciphertext: envelope.ciphertext,
      sentAt: body.sentAt,
      receivedAt: event.timestamp,
      trustedSender,
      payment: body.payment,
      untrustedDecision,
    });
    return { message, command };
  }

  const controlPlaneDecision = await evaluateConnectionCommand(
    options.store,
    command,
    existingContact,
    senderAddress,
    resolvedContact?.legacyPeerId,
    options.expectedChainId,
    event.timestamp,
    options.config?.commAutoAcceptInvites,
    inlineCardDecision,
  );
  const message = persistInboundMessage(options.store, {
    peerId: resolveInboundMessagePeerId({
      contact: controlPlaneDecision.contact ?? resolvedContact ?? undefined,
      senderAddress,
    }),
    txHash: event.txHash,
    nonce: body.msgId,
    msgId: body.msgId,
    commandType: command.type,
    envelopeVersion: envelope.version,
    contactId: controlPlaneDecision.contact?.contactId ?? resolvedContact?.contactId,
    identityWallet: body.sender.identityWallet,
    transportAddress: senderAddress,
    trustOutcome: controlPlaneDecision.trustOutcome,
    decryptedCommandType: command.type,
    ciphertext: envelope.ciphertext,
    status: controlPlaneDecision.messageStatus,
    error: controlPlaneDecision.messageError,
    sentAt: body.sentAt,
    receivedAt: event.timestamp,
  });

  if (controlPlaneDecision.contact) {
    recordInboundConnectionEvent(options.store, {
      command,
      contact: controlPlaneDecision.contact,
      messageId: message.id,
      txHash: event.txHash,
      occurredAt: event.timestamp,
      eventStatus: controlPlaneDecision.eventStatus,
      eventReason: controlPlaneDecision.eventReason ?? controlPlaneDecision.messageError,
      eventMetadata: controlPlaneDecision.eventMetadata,
      trustedSender: controlPlaneDecision.contact.status === "trusted",
      envelopeVersion: envelope.version,
      senderIdentityWallet: body.sender.identityWallet,
      recipientKeyId: envelope.kex.recipientKeyId,
    });
  }

  return { message, command };
}

export async function processInbox(
  options: InboxProcessorOptions,
  event: TransactionEvent,
): Promise<ProcessInboxResult> {
  const eventRecipient = normalizeAddress(event.to, "transaction recipient");
  const localReceiveKey = resolveReceiveKeyByAddress(options, eventRecipient);
  if (!localReceiveKey) {
    throw new InboxProcessingError("RECIPIENT_MISMATCH", "Transaction is not addressed to a configured local receive wallet", {
      txHash: event.txHash,
      received: eventRecipient,
    });
  }

  const envelope = withInboxError(
    "INVALID_ENVELOPE",
    "Failed to decode calldata envelope",
    { txHash: event.txHash },
    () => decodeEnvelope(event.calldata),
  );

  if (envelope.version === 1) {
    return processInboxV1(options, event, localReceiveKey, envelope);
  }
  return processInboxV2(options, event, localReceiveKey, envelope);
}
