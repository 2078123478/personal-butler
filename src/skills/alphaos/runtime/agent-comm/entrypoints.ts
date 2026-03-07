import crypto from "node:crypto";
import type { AlphaOsConfig } from "../config";
import type { StateStore } from "../state-store";
import type { VaultService } from "../vault";
import { encodeEnvelope } from "./calldata-codec";
import { deriveSharedKey, encrypt } from "./ecdh-crypto";
import { registerPeer } from "./peer-registry";
import { generateShadowWallet, restoreShadowWallet, type ShadowWallet } from "./shadow-wallet";
import { sendCalldata, type SendResult } from "./tx-sender";
import type {
  AgentCommSignedContactCardArtifact,
  AgentCommSignedIdentityArtifactBundle,
  AgentCommSignedTransportBindingArtifact,
} from "./artifact-workflow";
import {
  buildLocalIdentityArtifacts,
  parseSignedIdentityArtifactBundle,
  signIdentityArtifactBundle,
  verifySignedIdentityArtifactBundle,
} from "./artifact-workflow";
import {
  AGENT_COMM_ENVELOPE_VERSION,
  agentCommandSchema,
  type AgentCommand,
  type AgentLocalIdentity,
  type AgentPeer,
  type AgentPeerCapability,
  type PingCommandPayload,
  type StartDiscoveryCommandPayload,
} from "./types";

const DEFAULT_TRUSTED_PEER_CAPABILITIES: AgentPeerCapability[] = ["ping", "start_discovery"];
const DEFAULT_CONTACT_CARD_PROTOCOLS = ["agent-comm/2", "agent-comm/1"] as const;
const DEFAULT_CONTACT_CARD_EXPIRY_DAYS = 180;
const DEFAULT_TEMPORARY_DEMO_WALLET_ALIAS_SUFFIX = "-demo";

export const identityArtifactFailureCodes = [
  "bad_signature",
  "expired_artifact",
  "domain_mismatch",
  "malformed_transport_binding",
  "invalid_artifact",
] as const;

export interface AgentCommEntrypointDependencies {
  config: AlphaOsConfig;
  store: StateStore;
  vault: VaultService;
}

export interface AgentCommIdentity {
  address: string;
  pubkey: string;
  chainId: number;
  walletAlias: string;
  defaultSenderPeerId: string;
}

export interface InitCommWalletOptions {
  masterPassword?: string;
  privateKey?: string;
  senderPeerId?: string;
}

export interface InitCommWalletResult extends AgentCommIdentity {
  source: "generated" | "restored";
  replaced: boolean;
}

export interface InitTemporaryDemoWalletOptions extends InitCommWalletOptions {
  walletAlias?: string;
}

export interface InitTemporaryDemoWalletResult extends AgentCommIdentity {
  source: "generated" | "restored";
  replaced: boolean;
  role: "temporary_demo";
}

export interface RegisterTrustedPeerOptions {
  peerId: string;
  walletAddress: string;
  pubkey: string;
  name?: string;
  capabilities?: AgentPeerCapability[];
  metadata?: Record<string, unknown>;
}

export interface SendCommCommandOptions {
  masterPassword?: string;
  peerId: string;
  senderPeerId?: string;
  command: AgentCommand;
}

export interface SendCommCommandResult extends AgentCommIdentity, SendResult {
  peerId: string;
  recipient: string;
  senderPeerId: string;
  commandType: AgentCommand["type"];
}

export interface ExportIdentityArtifactBundleOptions {
  masterPassword?: string;
  displayName?: string;
  handle?: string;
  capabilityProfile?: string;
  capabilities?: string[];
  expiresInDays?: number;
  keyId?: string;
  legacyPeerId?: string;
  nowUnixSeconds?: number;
}

export interface ExportIdentityArtifactBundleResult {
  identity: AgentCommIdentity;
  profiles: AgentLocalIdentity[];
  bundle: AgentCommSignedIdentityArtifactBundle;
  contactCardDigest: string;
  contactCardFingerprint: string;
  transportBindingDigest: string;
  transportBindingFingerprint: string;
}

export interface ImportIdentityArtifactBundleResult {
  ok: boolean;
  reasons: string[];
  failureCodes: IdentityArtifactFailureCode[];
  contactCardDigest?: string;
  contactCardFingerprint?: string;
  transportBindingDigest?: string;
  transportBindingFingerprint?: string;
}

interface ResolvedLocalWallet {
  wallet: ShadowWallet;
  identity: AgentCommIdentity;
}

function getRequiredMasterPassword(masterPassword?: string): string {
  const resolved = masterPassword ?? process.env.VAULT_MASTER_PASSWORD;
  if (!resolved) {
    throw new Error("VAULT_MASTER_PASSWORD is required for agent-comm wallet access");
  }
  return resolved;
}

function getRequiredCommRpcUrl(config: AlphaOsConfig): string {
  if (!config.commRpcUrl) {
    throw new Error("COMM_RPC_URL is required to send agent-comm messages");
  }
  return config.commRpcUrl;
}

function resolveSenderPeerId(config: AlphaOsConfig, senderPeerId?: string): string {
  const resolved = senderPeerId?.trim();
  return resolved && resolved.length > 0 ? resolved : config.commWalletAlias;
}

function toIdentity(
  config: AlphaOsConfig,
  wallet: ShadowWallet,
  senderPeerId?: string,
  walletAlias = config.commWalletAlias,
): AgentCommIdentity {
  return {
    address: wallet.getAddress(),
    pubkey: wallet.getPublicKey(),
    chainId: config.commChainId,
    walletAlias,
    defaultSenderPeerId: resolveSenderPeerId(config, senderPeerId),
  };
}

function resolveLocalWallet(
  deps: AgentCommEntrypointDependencies,
  masterPassword: string,
  senderPeerId?: string,
): ResolvedLocalWallet {
  const privateKey = deps.vault.getSecret(deps.config.commWalletAlias, masterPassword);
  const wallet = restoreShadowWallet(privateKey);
  return {
    wallet,
    identity: toIdentity(deps.config, wallet, senderPeerId),
  };
}

function getTrustedPeer(store: StateStore, peerId: string): AgentPeer {
  const peer = store.getAgentPeer(peerId);
  if (!peer) {
    throw new Error(`Trusted peer not found: ${peerId}`);
  }
  if (peer.status !== "trusted") {
    throw new Error(`Peer is not trusted: ${peerId}`);
  }
  return peer;
}

function ensurePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function normalizeExpiresInDays(expiresInDays?: number): number {
  if (expiresInDays === undefined) {
    return DEFAULT_CONTACT_CARD_EXPIRY_DAYS;
  }
  return ensurePositiveInteger(expiresInDays, "expiresInDays");
}

function defaultDisplayName(config: AlphaOsConfig, address: string): string {
  const shortAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;
  return `${config.commWalletAlias} (${shortAddress})`;
}

function defaultKeyId(nowUnixSeconds: number): string {
  return `rk_${nowUnixSeconds}`;
}

function defaultTemporaryDemoWalletAlias(config: AlphaOsConfig): string {
  return `${config.commWalletAlias}${DEFAULT_TEMPORARY_DEMO_WALLET_ALIAS_SUFFIX}`;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function classifyIdentityArtifactFailure(reason: string): IdentityArtifactFailureCode {
  const normalized = reason.toLowerCase();
  if (normalized.includes("malformed transport binding")) {
    return "malformed_transport_binding";
  }
  if (normalized.includes("domain mismatch")) {
    return "domain_mismatch";
  }
  if (normalized.includes("expired artifact")) {
    return "expired_artifact";
  }
  if (normalized.includes("bad signature")) {
    return "bad_signature";
  }
  return "invalid_artifact";
}

function classifyIdentityArtifactFailures(reasons: string[]): IdentityArtifactFailureCode[] {
  const codes = reasons.map((reason) => classifyIdentityArtifactFailure(reason));
  return [...new Set(codes)];
}

function ensureLegacyDualUseIdentityProfiles(
  deps: Pick<AgentCommEntrypointDependencies, "config" | "store">,
  wallet: ShadowWallet,
  acwPatch: {
    activeBindingDigest?: string;
    transportKeyId?: string;
  } = {},
): AgentLocalIdentity[] {
  const walletAddress = wallet.getAddress();
  const sharedInput = {
    walletAlias: deps.config.commWalletAlias,
    walletAddress,
    identityWallet: walletAddress,
    chainId: deps.config.commChainId,
    mode: "temporary_dual_use" as const,
  };
  const liw = deps.store.upsertAgentLocalIdentity({
    role: "liw",
    ...sharedInput,
  });
  const acw = deps.store.upsertAgentLocalIdentity({
    role: "acw",
    ...sharedInput,
    activeBindingDigest: acwPatch.activeBindingDigest,
    transportKeyId: acwPatch.transportKeyId,
  });

  const temporaryDemo = deps.store.getAgentLocalIdentity("temporary_demo");
  return temporaryDemo ? [liw, acw, temporaryDemo] : [liw, acw];
}

function persistSignedContactCardArtifact(
  store: StateStore,
  artifact: AgentCommSignedContactCardArtifact,
  digest: string,
  source: string,
  verificationStatus: "verified" | "invalid",
  verificationError?: string,
): void {
  store.upsertAgentSignedArtifact({
    artifactType: "ContactCard",
    digest,
    signer: artifact.proof.signer,
    identityWallet: artifact.identityWallet,
    chainId: artifact.transport.chainId,
    issuedAt: artifact.issuedAt,
    expiresAt: artifact.expiresAt,
    payload: {
      cardVersion: artifact.cardVersion,
      protocols: artifact.protocols,
      displayName: artifact.displayName,
      handle: artifact.handle,
      identityWallet: artifact.identityWallet,
      transport: artifact.transport,
      defaults: artifact.defaults,
      issuedAt: artifact.issuedAt,
      expiresAt: artifact.expiresAt,
      legacyPeerId: artifact.legacyPeerId,
    },
    proof: artifact.proof as unknown as Record<string, unknown>,
    verificationStatus,
    verificationError,
    source,
  });
}

function persistSignedTransportBindingArtifact(
  store: StateStore,
  artifact: AgentCommSignedTransportBindingArtifact,
  digest: string,
  source: string,
  verificationStatus: "verified" | "invalid",
  verificationError?: string,
): void {
  store.upsertAgentSignedArtifact({
    artifactType: "TransportBinding",
    digest,
    signer: artifact.proof.signer,
    identityWallet: artifact.identityWallet,
    chainId: artifact.chainId,
    issuedAt: artifact.issuedAt,
    expiresAt: artifact.expiresAt,
    payload: {
      bindingVersion: artifact.bindingVersion,
      identityWallet: artifact.identityWallet,
      chainId: artifact.chainId,
      receiveAddress: artifact.receiveAddress,
      pubkey: artifact.pubkey,
      keyId: artifact.keyId,
      issuedAt: artifact.issuedAt,
      expiresAt: artifact.expiresAt,
    },
    proof: artifact.proof as unknown as Record<string, unknown>,
    verificationStatus,
    verificationError,
    source,
  });
}

export function getCommIdentity(
  deps: AgentCommEntrypointDependencies,
  options: { masterPassword?: string; senderPeerId?: string } = {},
): AgentCommIdentity {
  const masterPassword = getRequiredMasterPassword(options.masterPassword);
  const local = resolveLocalWallet(deps, masterPassword, options.senderPeerId);
  ensureLegacyDualUseIdentityProfiles(deps, local.wallet);
  return local.identity;
}

export function initCommWallet(
  deps: AgentCommEntrypointDependencies,
  options: InitCommWalletOptions = {},
): InitCommWalletResult {
  const masterPassword = getRequiredMasterPassword(options.masterPassword);
  const wallet = options.privateKey
    ? restoreShadowWallet(options.privateKey)
    : generateShadowWallet();
  const replaced = deps.store.getVaultItem(deps.config.commWalletAlias) !== null;

  deps.vault.setSecret(deps.config.commWalletAlias, wallet.privateKey, masterPassword);
  ensureLegacyDualUseIdentityProfiles(deps, wallet);

  return {
    ...toIdentity(deps.config, wallet, options.senderPeerId),
    source: options.privateKey ? "restored" : "generated",
    replaced,
  };
}

export function initTemporaryDemoWallet(
  deps: AgentCommEntrypointDependencies,
  options: InitTemporaryDemoWalletOptions = {},
): InitTemporaryDemoWalletResult {
  const masterPassword = getRequiredMasterPassword(options.masterPassword);
  const walletAlias =
    normalizeOptionalText(options.walletAlias) ?? defaultTemporaryDemoWalletAlias(deps.config);
  const wallet = options.privateKey
    ? restoreShadowWallet(options.privateKey)
    : generateShadowWallet();
  const replaced = deps.store.getVaultItem(walletAlias) !== null;

  deps.vault.setSecret(walletAlias, wallet.privateKey, masterPassword);
  deps.store.upsertAgentLocalIdentity({
    role: "temporary_demo",
    walletAlias,
    walletAddress: wallet.getAddress(),
    identityWallet: wallet.getAddress(),
    chainId: deps.config.commChainId,
    mode: "standard",
    metadata: {
      purpose: "temporary_demo",
    },
  });

  return {
    ...toIdentity(deps.config, wallet, options.senderPeerId, walletAlias),
    source: options.privateKey ? "restored" : "generated",
    replaced,
    role: "temporary_demo",
  };
}

export function registerTrustedPeerEntry(
  deps: Pick<AgentCommEntrypointDependencies, "store">,
  options: RegisterTrustedPeerOptions,
): AgentPeer {
  const peer = registerPeer(deps.store, {
    peerId: options.peerId,
    walletAddress: options.walletAddress,
    pubkey: options.pubkey,
    name: options.name,
    status: "trusted",
    capabilities: options.capabilities ?? DEFAULT_TRUSTED_PEER_CAPABILITIES,
    metadata: options.metadata,
  });
  deps.store.backfillAgentContactFromLegacyPeer(peer.peerId);
  return peer;
}

export function listLocalIdentityProfiles(
  deps: AgentCommEntrypointDependencies,
  options: { masterPassword?: string } = {},
): AgentLocalIdentity[] {
  const existingProfiles = deps.store.listAgentLocalIdentities();
  if (existingProfiles.length > 0) {
    return existingProfiles;
  }

  const masterPassword = getRequiredMasterPassword(options.masterPassword);
  const local = resolveLocalWallet(deps, masterPassword);
  return ensureLegacyDualUseIdentityProfiles(deps, local.wallet);
}

export async function exportIdentityArtifactBundle(
  deps: AgentCommEntrypointDependencies,
  options: ExportIdentityArtifactBundleOptions = {},
): Promise<ExportIdentityArtifactBundleResult> {
  const masterPassword = getRequiredMasterPassword(options.masterPassword);
  const local = resolveLocalWallet(deps, masterPassword);
  const nowUnixSeconds = options.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(nowUnixSeconds) || nowUnixSeconds < 0) {
    throw new Error("nowUnixSeconds must be a non-negative integer");
  }
  const expiresInDays = normalizeExpiresInDays(options.expiresInDays);
  const expiresAt = nowUnixSeconds + expiresInDays * 24 * 60 * 60;
  const keyId = normalizeOptionalText(options.keyId) ?? defaultKeyId(nowUnixSeconds);
  const displayName =
    normalizeOptionalText(options.displayName) ??
    defaultDisplayName(deps.config, local.identity.address);

  const capabilities = options.capabilities?.map((value) => value.trim()).filter(Boolean);
  const artifacts = buildLocalIdentityArtifacts({
    identityWallet: local.identity.address,
    transportAddress: local.identity.address,
    transportPubkey: local.identity.pubkey,
    chainId: deps.config.commChainId,
    displayName,
    handle: options.handle,
    keyId,
    capabilityProfile: options.capabilityProfile,
    capabilities: capabilities && capabilities.length > 0 ? capabilities : undefined,
    issuedAt: nowUnixSeconds,
    expiresAt,
    protocols: [...DEFAULT_CONTACT_CARD_PROTOCOLS],
    legacyPeerId: normalizeOptionalText(options.legacyPeerId) ?? "",
  });

  const bundle = await signIdentityArtifactBundle({
    ...artifacts,
    signerPrivateKey: local.wallet.privateKey,
    exportedAt: nowUnixSeconds,
  });

  const verification = await verifySignedIdentityArtifactBundle(bundle, {
    expectedChainId: deps.config.commChainId,
    nowUnixSeconds,
  });

  if (!verification.ok || !verification.contactCard || !verification.transportBinding) {
    throw new Error(
      `failed to self-verify exported identity artifacts: ${verification.errors.join("; ")}`,
    );
  }

  persistSignedContactCardArtifact(
    deps.store,
    verification.contactCard.artifact,
    verification.contactCard.digest,
    "local_export",
    "verified",
  );
  persistSignedTransportBindingArtifact(
    deps.store,
    verification.transportBinding.artifact,
    verification.transportBinding.digest,
    "local_export",
    "verified",
  );

  const profiles = ensureLegacyDualUseIdentityProfiles(deps, local.wallet, {
    activeBindingDigest: verification.transportBinding.digest,
    transportKeyId: keyId,
  });

  return {
    identity: local.identity,
    profiles,
    bundle,
    contactCardDigest: verification.contactCard.digest,
    contactCardFingerprint: verification.contactCard.fingerprint,
    transportBindingDigest: verification.transportBinding.digest,
    transportBindingFingerprint: verification.transportBinding.fingerprint,
  };
}

export async function importIdentityArtifactBundle(
  deps: Pick<AgentCommEntrypointDependencies, "config" | "store">,
  input: {
    bundle: unknown;
    source?: string;
    expectedChainId?: number;
    nowUnixSeconds?: number;
  },
): Promise<ImportIdentityArtifactBundleResult> {
  const verification = await verifySignedIdentityArtifactBundle(input.bundle, {
    expectedChainId: input.expectedChainId ?? deps.config.commChainId,
    nowUnixSeconds: input.nowUnixSeconds,
  });
  const source = input.source ?? "local_import";
  const reasons = verification.errors;

  if (verification.contactCard) {
    persistSignedContactCardArtifact(
      deps.store,
      verification.contactCard.artifact,
      verification.contactCard.digest,
      source,
      verification.contactCard.ok ? "verified" : "invalid",
      verification.contactCard.ok ? undefined : reasons.join("; "),
    );
  }

  if (verification.transportBinding) {
    persistSignedTransportBindingArtifact(
      deps.store,
      verification.transportBinding.artifact,
      verification.transportBinding.digest,
      source,
      verification.transportBinding.ok ? "verified" : "invalid",
      verification.transportBinding.ok ? undefined : reasons.join("; "),
    );
  }

  return {
    ok: verification.ok,
    reasons,
    failureCodes: classifyIdentityArtifactFailures(reasons),
    contactCardDigest: verification.contactCard?.digest,
    contactCardFingerprint: verification.contactCard?.fingerprint,
    transportBindingDigest: verification.transportBinding?.digest,
    transportBindingFingerprint: verification.transportBinding?.fingerprint,
  };
}

export async function importIdentityArtifactBundleFromJson(
  deps: Pick<AgentCommEntrypointDependencies, "config" | "store">,
  rawJson: string,
  options: {
    source?: string;
    expectedChainId?: number;
    nowUnixSeconds?: number;
  } = {},
): Promise<ImportIdentityArtifactBundleResult> {
  let bundle: AgentCommSignedIdentityArtifactBundle;
  try {
    bundle = parseSignedIdentityArtifactBundle(rawJson);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reasons: [reason],
      failureCodes: ["invalid_artifact"],
    };
  }
  return importIdentityArtifactBundle(deps, {
    bundle,
    source: options.source,
    expectedChainId: options.expectedChainId,
    nowUnixSeconds: options.nowUnixSeconds,
  });
}

export type IdentityArtifactFailureCode = (typeof identityArtifactFailureCodes)[number];

export async function sendCommCommand(
  deps: AgentCommEntrypointDependencies,
  options: SendCommCommandOptions,
): Promise<SendCommCommandResult> {
  const command = agentCommandSchema.parse(options.command);
  const masterPassword = getRequiredMasterPassword(options.masterPassword);
  const local = resolveLocalWallet(deps, masterPassword, options.senderPeerId);
  const peer = getTrustedPeer(deps.store, options.peerId);
  const senderPeerId = resolveSenderPeerId(deps.config, options.senderPeerId);
  const nonce = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const sharedKey = deriveSharedKey(local.wallet.privateKey, peer.pubkey);
  const ciphertext = encrypt(JSON.stringify(command), sharedKey);
  const calldata = encodeEnvelope({
    version: AGENT_COMM_ENVELOPE_VERSION,
    senderPeerId,
    senderPubkey: local.identity.pubkey,
    recipient: peer.walletAddress,
    nonce,
    timestamp,
    command: {
      type: command.type,
      schemaVersion: 1,
    },
    ciphertext,
    signature: local.identity.pubkey,
  });
  const result = await sendCalldata(
    {
      rpcUrl: getRequiredCommRpcUrl(deps.config),
      chainId: deps.config.commChainId,
      walletAlias: deps.config.commWalletAlias,
      store: deps.store,
      outboundMessage: {
        peerId: peer.peerId,
      },
    },
    local.wallet,
    peer.walletAddress,
    calldata,
  );

  return {
    ...local.identity,
    ...result,
    peerId: peer.peerId,
    recipient: peer.walletAddress,
    senderPeerId,
    commandType: command.type,
  };
}

export async function sendCommPing(
  deps: AgentCommEntrypointDependencies,
  options: {
    masterPassword?: string;
    peerId: string;
    senderPeerId?: string;
    echo?: PingCommandPayload["echo"];
    note?: PingCommandPayload["note"];
  },
): Promise<SendCommCommandResult> {
  return sendCommCommand(deps, {
    masterPassword: options.masterPassword,
    peerId: options.peerId,
    senderPeerId: options.senderPeerId,
    command: {
      type: "ping",
      payload: {
        ...(options.echo ? { echo: options.echo } : {}),
        ...(options.note ? { note: options.note } : {}),
      },
    },
  });
}

export async function sendCommStartDiscovery(
  deps: AgentCommEntrypointDependencies,
  options: {
    masterPassword?: string;
    peerId: string;
    senderPeerId?: string;
    strategyId: string;
    pairs?: StartDiscoveryCommandPayload["pairs"];
    durationMinutes?: StartDiscoveryCommandPayload["durationMinutes"];
    sampleIntervalSec?: StartDiscoveryCommandPayload["sampleIntervalSec"];
    topN?: StartDiscoveryCommandPayload["topN"];
  },
): Promise<SendCommCommandResult> {
  return sendCommCommand(deps, {
    masterPassword: options.masterPassword,
    peerId: options.peerId,
    senderPeerId: options.senderPeerId,
    command: {
      type: "start_discovery",
      payload: {
        strategyId: options.strategyId as StartDiscoveryCommandPayload["strategyId"],
        ...(options.pairs ? { pairs: options.pairs } : {}),
        ...(options.durationMinutes ? { durationMinutes: options.durationMinutes } : {}),
        ...(options.sampleIntervalSec ? { sampleIntervalSec: options.sampleIntervalSec } : {}),
        ...(options.topN ? { topN: options.topN } : {}),
      },
    },
  });
}
