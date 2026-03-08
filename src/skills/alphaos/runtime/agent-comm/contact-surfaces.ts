import { formatArtifactFingerprint } from "./artifact-contracts";
import type { StateStore } from "../state-store";
import { isLegacyOnlyProtocolSet } from "./protocol-negotiation";
import type {
  AgentConnectionEvent,
  AgentConnectionEventStatus,
  AgentContact,
  AgentContactStatus,
  AgentLocalIdentity,
  AgentMessageDirection,
  AgentSignedArtifact,
  AgentTransportEndpoint,
} from "./types";

const millisecondsPerDay = 24 * 60 * 60 * 1000;
export const defaultArtifactExpiryWarningDays = 7;

export interface AgentPendingInviteCounts {
  inbound: number;
  outbound: number;
  total: number;
}

export interface AgentPendingInviteSummary {
  direction: AgentMessageDirection;
  occurredAt: string;
  requestedProfile?: string;
  requestedCapabilities?: string[];
  note?: string;
}

export interface AgentContactSurfaceItem extends AgentContact {
  proofSigner?: string;
  signerFingerprint?: string;
  currentTransportAddress?: string;
  currentTransportKeyId?: string;
  pendingInvites: AgentPendingInviteCounts;
  latestPendingInvite?: AgentPendingInviteSummary;
  legacyMarkers: string[];
  legacyProtocolOnly: boolean;
  legacyManualPeerRecord: boolean;
}

export interface AgentInviteSurfaceItem extends AgentConnectionEvent {
  contactStatus?: AgentContactStatus;
  displayName?: string;
  handle?: string;
  capabilityProfile?: string;
  capabilities?: string[];
  proofSigner?: string;
  signerFingerprint?: string;
  currentTransportAddress?: string;
  currentTransportKeyId?: string;
  requestedProfile?: string;
  requestedCapabilities?: string[];
  note?: string;
  senderPeerId?: string;
  legacyMarkers?: string[];
  legacyProtocolOnly?: boolean;
  legacyManualPeerRecord?: boolean;
}

export interface AgentArtifactExpiryWarning {
  type: "contact_card" | "transport_binding";
  expiresAt: string;
  daysRemaining: number;
}

function readMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readMetadataStringArray(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined {
  const value = metadata?.[key];
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length > 0 ? [...new Set(items)] : undefined;
}

function getActiveTransportEndpoint(
  store: StateStore,
  contactId: string,
): AgentTransportEndpoint | undefined {
  return store.listAgentTransportEndpoints(1, {
    contactId,
    endpointStatus: "active",
  })[0];
}

function getIdentityProofArtifact(
  store: StateStore,
  identityWallet: string,
  bindingDigest?: string,
): AgentSignedArtifact | undefined {
  const verifiedArtifacts = store
    .listAgentSignedArtifacts(20, { identityWallet })
    .filter((artifact) => artifact.verificationStatus === "verified");

  const contactCardArtifact = verifiedArtifacts.find((artifact) => artifact.artifactType === "ContactCard");
  if (contactCardArtifact) {
    return contactCardArtifact;
  }

  if (bindingDigest) {
    const bindingArtifact = store.getAgentSignedArtifact(bindingDigest);
    if (bindingArtifact?.verificationStatus === "verified") {
      return bindingArtifact;
    }
  }

  return verifiedArtifacts.find((artifact) => artifact.artifactType === "TransportBinding");
}

function findCurrentLocalIdentityProfiles(store: StateStore): {
  liwProfile?: AgentLocalIdentity;
  acwProfile?: AgentLocalIdentity;
} {
  const localProfiles = store
    .listAgentLocalIdentities(10)
    .filter((profile) => profile.role === "liw" || profile.role === "acw");

  return {
    liwProfile: localProfiles.find((profile) => profile.role === "liw"),
    acwProfile: localProfiles.find((profile) => profile.role === "acw"),
  };
}

function listVerifiedLocalExportArtifacts(
  store: StateStore,
  identityWallet: string,
): AgentSignedArtifact[] {
  return store
    .listAgentSignedArtifacts(100, { identityWallet })
    .filter(
      (artifact) =>
        artifact.source === "local_export"
        && artifact.verificationStatus === "verified"
        && (artifact.artifactType === "ContactCard" || artifact.artifactType === "TransportBinding"),
    );
}

function readPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readContactCardTransportAddress(artifact: AgentSignedArtifact): string | undefined {
  const transport = artifact.payload["transport"];
  if (!transport || typeof transport !== "object" || Array.isArray(transport)) {
    return undefined;
  }
  return readPayloadString(transport as Record<string, unknown>, "receiveAddress");
}

function readContactCardTransportKeyId(artifact: AgentSignedArtifact): string | undefined {
  const transport = artifact.payload["transport"];
  if (!transport || typeof transport !== "object" || Array.isArray(transport)) {
    return undefined;
  }
  return readPayloadString(transport as Record<string, unknown>, "keyId");
}

function readTransportBindingAddress(artifact: AgentSignedArtifact): string | undefined {
  return readPayloadString(artifact.payload, "receiveAddress");
}

function readTransportBindingKeyId(artifact: AgentSignedArtifact): string | undefined {
  return readPayloadString(artifact.payload, "keyId");
}

function findCurrentLocalContactCard(
  artifacts: AgentSignedArtifact[],
  acwProfile?: AgentLocalIdentity,
): AgentSignedArtifact | undefined {
  const contactCards = artifacts.filter((artifact) => artifact.artifactType === "ContactCard");
  if (!acwProfile) {
    return contactCards[0];
  }

  const matchingContactCard = contactCards.find((artifact) => {
    const receiveAddress = readContactCardTransportAddress(artifact);
    const keyId = readContactCardTransportKeyId(artifact);
    if (receiveAddress?.toLowerCase() !== acwProfile.walletAddress.toLowerCase()) {
      return false;
    }
    if (acwProfile.transportKeyId && keyId && keyId !== acwProfile.transportKeyId) {
      return false;
    }
    return true;
  });

  return matchingContactCard ?? contactCards[0];
}

function findCurrentLocalTransportBinding(
  artifacts: AgentSignedArtifact[],
  acwProfile?: AgentLocalIdentity,
): AgentSignedArtifact | undefined {
  const bindings = artifacts.filter((artifact) => artifact.artifactType === "TransportBinding");
  if (!acwProfile) {
    return bindings[0];
  }

  const activeBindingDigest = acwProfile.activeBindingDigest;
  if (activeBindingDigest) {
    const activeBinding = bindings.find(
      (artifact) => artifact.digest.toLowerCase() === activeBindingDigest.toLowerCase(),
    );
    if (activeBinding) {
      return activeBinding;
    }
  }

  const matchingBinding = bindings.find((artifact) => {
    const receiveAddress = readTransportBindingAddress(artifact);
    const keyId = readTransportBindingKeyId(artifact);
    if (receiveAddress?.toLowerCase() !== acwProfile.walletAddress.toLowerCase()) {
      return false;
    }
    if (acwProfile.transportKeyId && keyId && keyId !== acwProfile.transportKeyId) {
      return false;
    }
    return true;
  });

  return matchingBinding ?? bindings[0];
}

function toExpiryWarning(
  artifact: AgentSignedArtifact | undefined,
  type: AgentArtifactExpiryWarning["type"],
  nowMs: number,
  thresholdMs: number,
): AgentArtifactExpiryWarning | undefined {
  if (!artifact) {
    return undefined;
  }

  const expiresAtMs = artifact.expiresAt * 1000;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs || expiresAtMs > nowMs + thresholdMs) {
    return undefined;
  }

  return {
    type,
    expiresAt: new Date(expiresAtMs).toISOString(),
    daysRemaining: Math.max(1, Math.ceil((expiresAtMs - nowMs) / millisecondsPerDay)),
  };
}

export function checkExpiringArtifacts(
  store: StateStore,
  options: {
    now?: Date;
    warningThresholdDays?: number;
  } = {},
): AgentArtifactExpiryWarning[] {
  const { liwProfile, acwProfile } = findCurrentLocalIdentityProfiles(store);
  const localIdentityWallet = liwProfile?.identityWallet ?? acwProfile?.identityWallet;
  if (!localIdentityWallet) {
    return [];
  }

  const nowMs = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) {
    return [];
  }

  const warningThresholdDays = Math.max(
    0,
    Math.floor(options.warningThresholdDays ?? defaultArtifactExpiryWarningDays),
  );
  const thresholdMs = warningThresholdDays * millisecondsPerDay;
  const localArtifacts = listVerifiedLocalExportArtifacts(store, localIdentityWallet);
  const expiryWarnings = [
    toExpiryWarning(
      findCurrentLocalContactCard(localArtifacts, acwProfile),
      "contact_card",
      nowMs,
      thresholdMs,
    ),
    toExpiryWarning(
      findCurrentLocalTransportBinding(localArtifacts, acwProfile),
      "transport_binding",
      nowMs,
      thresholdMs,
    ),
  ].filter((warning): warning is AgentArtifactExpiryWarning => Boolean(warning));

  return expiryWarnings.sort((left, right) => left.expiresAt.localeCompare(right.expiresAt));
}

function listPendingInviteEvents(
  store: StateStore,
  contactId: string,
  direction: AgentMessageDirection,
): AgentConnectionEvent[] {
  return store.listAgentConnectionEvents(1000, {
    contactId,
    direction,
    eventType: "connection_invite",
    eventStatus: "pending" as AgentConnectionEventStatus,
  });
}

function buildPendingInviteCounts(
  inboundPendingInvites: AgentConnectionEvent[],
  outboundPendingInvites: AgentConnectionEvent[],
): AgentPendingInviteCounts {
  return {
    inbound: inboundPendingInvites.length,
    outbound: outboundPendingInvites.length,
    total: inboundPendingInvites.length + outboundPendingInvites.length,
  };
}

function toPendingInviteSummary(event: AgentConnectionEvent): AgentPendingInviteSummary {
  return {
    direction: event.direction,
    occurredAt: event.occurredAt,
    requestedProfile: readMetadataString(event.metadata, "requestedProfile"),
    requestedCapabilities: readMetadataStringArray(event.metadata, "requestedCapabilities"),
    note: readMetadataString(event.metadata, "note"),
  };
}

function getLatestPendingInvite(
  inboundPendingInvites: AgentConnectionEvent[],
  outboundPendingInvites: AgentConnectionEvent[],
): AgentPendingInviteSummary | undefined {
  const latestInbound = inboundPendingInvites[0];
  const latestOutbound = outboundPendingInvites[0];

  if (!latestInbound && !latestOutbound) {
    return undefined;
  }
  if (!latestInbound) {
    return toPendingInviteSummary(latestOutbound as AgentConnectionEvent);
  }
  if (!latestOutbound) {
    return toPendingInviteSummary(latestInbound);
  }

  return latestInbound.occurredAt >= latestOutbound.occurredAt
    ? toPendingInviteSummary(latestInbound)
    : toPendingInviteSummary(latestOutbound);
}

function buildLegacyMarkers(contact: AgentContact): {
  legacyMarkers: string[];
  legacyProtocolOnly: boolean;
  legacyManualPeerRecord: boolean;
} {
  const legacyProtocolOnly = isLegacyOnlyProtocolSet(contact.supportedProtocols);
  const legacyManualPeerRecord = Boolean(
    contact.metadata
    && typeof contact.metadata === "object"
    && !Array.isArray(contact.metadata)
    && "legacyBackfill" in contact.metadata,
  );
  const legacyMarkers = [
    ...(legacyProtocolOnly ? ["v1_only"] : []),
    ...(legacyManualPeerRecord ? ["manual_peer_record"] : []),
  ];
  return {
    legacyMarkers,
    legacyProtocolOnly,
    legacyManualPeerRecord,
  };
}

function buildContactSurfaceDetails(
  store: StateStore,
  contact: AgentContact,
): Omit<AgentContactSurfaceItem, keyof AgentContact> {
  const activeEndpoint = getActiveTransportEndpoint(store, contact.contactId);
  const proofArtifact = getIdentityProofArtifact(
    store,
    contact.identityWallet,
    activeEndpoint?.bindingDigest,
  );
  const inboundPendingInvites = listPendingInviteEvents(store, contact.contactId, "inbound");
  const outboundPendingInvites = listPendingInviteEvents(store, contact.contactId, "outbound");

  return {
    ...(proofArtifact
      ? {
          proofSigner: proofArtifact.signer,
          signerFingerprint: formatArtifactFingerprint(
            proofArtifact.digest as `0x${string}`,
          ),
        }
      : {}),
    ...(activeEndpoint
      ? {
          currentTransportAddress: activeEndpoint.receiveAddress,
          currentTransportKeyId: activeEndpoint.keyId,
        }
      : {}),
    pendingInvites: buildPendingInviteCounts(inboundPendingInvites, outboundPendingInvites),
    ...(getLatestPendingInvite(inboundPendingInvites, outboundPendingInvites)
      ? {
          latestPendingInvite: getLatestPendingInvite(inboundPendingInvites, outboundPendingInvites),
        }
      : {}),
    ...buildLegacyMarkers(contact),
  };
}

function buildInviteSurfaceDetails(
  store: StateStore,
  event: AgentConnectionEvent,
): Omit<AgentInviteSurfaceItem, keyof AgentConnectionEvent> {
  const contact =
    store.getAgentContact(event.contactId) ?? store.getAgentContactByIdentityWallet(event.identityWallet);
  if (!contact) {
    return {
      requestedProfile: readMetadataString(event.metadata, "requestedProfile"),
      requestedCapabilities: readMetadataStringArray(event.metadata, "requestedCapabilities"),
      note: readMetadataString(event.metadata, "note"),
      senderPeerId: readMetadataString(event.metadata, "senderPeerId"),
      legacyMarkers: [],
      legacyProtocolOnly: false,
      legacyManualPeerRecord: false,
    };
  }

  const contactDetails = buildContactSurfaceDetails(store, contact);
  return {
    contactStatus: contact.status,
    displayName: contact.displayName,
    handle: contact.handle,
    capabilityProfile: contact.capabilityProfile,
    capabilities: contact.capabilities,
    proofSigner: contactDetails.proofSigner,
    signerFingerprint: contactDetails.signerFingerprint,
    currentTransportAddress: contactDetails.currentTransportAddress,
    currentTransportKeyId: contactDetails.currentTransportKeyId,
    requestedProfile: readMetadataString(event.metadata, "requestedProfile"),
    requestedCapabilities: readMetadataStringArray(event.metadata, "requestedCapabilities"),
    note: readMetadataString(event.metadata, "note"),
    senderPeerId: readMetadataString(event.metadata, "senderPeerId"),
    legacyMarkers: contactDetails.legacyMarkers,
    legacyProtocolOnly: contactDetails.legacyProtocolOnly,
    legacyManualPeerRecord: contactDetails.legacyManualPeerRecord,
  };
}

export function listAgentContactSurfaceItems(
  store: StateStore,
  limit = 100,
  filters?: {
    status?: AgentContactStatus;
    identityWallet?: string;
    legacyPeerId?: string;
  },
): AgentContactSurfaceItem[] {
  return store.listAgentContacts(limit, filters).map((contact) => ({
    ...contact,
    ...buildContactSurfaceDetails(store, contact),
  }));
}

export function listAgentInviteSurfaceItems(
  store: StateStore,
  limit = 100,
  filters?: {
    contactId?: string;
    identityWallet?: string;
    direction?: AgentMessageDirection;
    eventStatus?: AgentConnectionEventStatus;
  },
): AgentInviteSurfaceItem[] {
  return store
    .listAgentConnectionEvents(limit, {
      ...filters,
      eventType: "connection_invite",
    })
    .map((event) => ({
      ...event,
      ...buildInviteSurfaceDetails(store, event),
    }));
}
