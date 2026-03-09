import { z } from "zod";
import { getAddress, verifyTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AGENT_COMM_CONTACT_CARD_VERSION,
  AGENT_COMM_REVOCATION_NOTICE_VERSION,
  AGENT_COMM_TRANSPORT_BINDING_VERSION,
  computeContactCardDigest,
  computeRevocationNoticeDigest,
  computeTransportBindingDigest,
  contactCardSchema,
  formatArtifactFingerprint,
  getContactCardTypedData,
  getRevocationNoticeTypedData,
  getTransportBindingTypedData,
  revocationNoticeSchema,
  transportBindingSchema,
  type AgentCommArtifactDomainOptions,
  type AgentCommContactCard,
  type AgentCommContactCardDefaults,
  type AgentCommContactCardInput,
  type AgentCommRevocationNoticeInput,
  type AgentCommTransportBinding,
  type AgentCommTransportBindingInput,
} from "./artifact-contracts";

export const AGENT_COMM_IDENTITY_ARTIFACT_BUNDLE_VERSION = 1;

const bytes32HexSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected bytes32 hex")
  .transform((value) => value.toLowerCase() as Hex);

const signatureHexSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/, "expected 0x-prefixed signature hex")
  .transform((value) => value.toLowerCase() as Hex);

const signerAddressSchema = z.string().transform((value, ctx): Address => {
  try {
    return getAddress(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Invalid artifact signer: expected EVM address",
    });
    return z.NEVER;
  }
});

const artifactProofDomainSchema = z
  .object({
    salt: bytes32HexSchema.optional(),
  })
  .strict();

export const agentCommArtifactProofSchema = z
  .object({
    type: z.literal("eip712"),
    signer: signerAddressSchema,
    signature: signatureHexSchema,
    domain: artifactProofDomainSchema.optional(),
  })
  .strict();

export const signedContactCardArtifactSchema = contactCardSchema
  .extend({
    proof: agentCommArtifactProofSchema,
  })
  .strict();

export const signedTransportBindingArtifactSchema = transportBindingSchema
  .extend({
    proof: agentCommArtifactProofSchema,
  })
  .strict();

export const signedRevocationNoticeArtifactSchema = revocationNoticeSchema
  .extend({
    proof: agentCommArtifactProofSchema,
  })
  .strict();

export const signedIdentityArtifactBundleSchema = z
  .object({
    bundleVersion: z.literal(AGENT_COMM_IDENTITY_ARTIFACT_BUNDLE_VERSION),
    exportedAt: z.number().int().nonnegative(),
    contactCard: signedContactCardArtifactSchema,
    transportBinding: signedTransportBindingArtifactSchema,
  })
  .strict();

export interface AgentCommArtifactVerificationOptions {
  nowUnixSeconds?: number;
  expectedChainId?: number;
}

export interface AgentCommArtifactVerificationResult<TArtifact> {
  ok: boolean;
  errors: string[];
  artifact: TArtifact;
  digest: Hex;
  fingerprint: string;
  signatureVerified: boolean;
  signer: Address;
}

export interface AgentCommIdentityArtifactBundleVerificationResult {
  ok: boolean;
  errors: string[];
  contactCard?: AgentCommArtifactVerificationResult<AgentCommSignedContactCardArtifact>;
  transportBinding?: AgentCommArtifactVerificationResult<AgentCommSignedTransportBindingArtifact>;
  bundle?: AgentCommSignedIdentityArtifactBundle;
}

function uniqueErrors(errors: string[]): string[] {
  return [...new Set(errors)];
}

function toDomainOptions(
  proof: AgentCommArtifactProof,
): AgentCommArtifactDomainOptions | undefined {
  if (!proof.domain?.salt) {
    return undefined;
  }
  return {
    salt: proof.domain.salt,
  };
}

function nowUnixSecondsOrDefault(nowUnixSeconds?: number): number {
  return nowUnixSeconds ?? Math.floor(Date.now() / 1000);
}

function toUnsignedContactCard(
  artifact: AgentCommSignedContactCardArtifact,
): AgentCommContactCardInput {
  return {
    cardVersion: artifact.cardVersion,
    protocols: artifact.protocols,
    displayName: artifact.displayName,
    handle: artifact.handle,
    identityWallet: artifact.identityWallet,
    transport: {
      chainId: artifact.transport.chainId,
      receiveAddress: artifact.transport.receiveAddress,
      pubkey: artifact.transport.pubkey,
      keyId: artifact.transport.keyId,
    },
    defaults: {
      capabilityProfile: artifact.defaults.capabilityProfile,
      capabilities: artifact.defaults.capabilities,
    },
    issuedAt: artifact.issuedAt,
    expiresAt: artifact.expiresAt,
    legacyPeerId: artifact.legacyPeerId,
  };
}

function toUnsignedTransportBinding(
  artifact: AgentCommSignedTransportBindingArtifact,
): AgentCommTransportBindingInput {
  return {
    bindingVersion: artifact.bindingVersion,
    identityWallet: artifact.identityWallet,
    chainId: artifact.chainId,
    receiveAddress: artifact.receiveAddress,
    pubkey: artifact.pubkey,
    keyId: artifact.keyId,
    issuedAt: artifact.issuedAt,
    expiresAt: artifact.expiresAt,
  };
}

function toUnsignedRevocationNotice(
  artifact: AgentCommSignedRevocationNoticeArtifact,
): AgentCommRevocationNoticeInput {
  return {
    noticeVersion: artifact.noticeVersion,
    identityWallet: artifact.identityWallet,
    chainId: artifact.chainId,
    artifactType: artifact.artifactType,
    artifactDigest: artifact.artifactDigest,
    replacementDigest: artifact.replacementDigest,
    reason: artifact.reason,
    revokedAt: artifact.revokedAt,
  };
}

function collectTransportBindingConsistencyErrors(
  card: AgentCommContactCard,
  binding: AgentCommTransportBinding,
): string[] {
  const errors: string[] = [];
  if (card.identityWallet !== binding.identityWallet) {
    errors.push(
      "malformed transport binding: identityWallet mismatch between ContactCard and TransportBinding",
    );
  }
  if (card.transport.chainId !== binding.chainId) {
    errors.push("malformed transport binding: chainId mismatch between ContactCard and TransportBinding");
  }
  if (card.transport.receiveAddress !== binding.receiveAddress) {
    errors.push(
      "malformed transport binding: receiveAddress mismatch between ContactCard and TransportBinding",
    );
  }
  if (card.transport.pubkey !== binding.pubkey) {
    errors.push("malformed transport binding: pubkey mismatch between ContactCard and TransportBinding");
  }
  if (card.transport.keyId !== binding.keyId) {
    errors.push("malformed transport binding: keyId mismatch between ContactCard and TransportBinding");
  }
  return errors;
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  });
}

async function verifyContactCardSignature(
  artifact: AgentCommSignedContactCardArtifact,
): Promise<boolean> {
  try {
    const unsigned = toUnsignedContactCard(artifact);
    const typedData = getContactCardTypedData(unsigned, toDomainOptions(artifact.proof));
    return await verifyTypedData({
      address: artifact.proof.signer,
      ...typedData,
      signature: artifact.proof.signature,
    });
  } catch {
    return false;
  }
}

async function verifyTransportBindingSignature(
  artifact: AgentCommSignedTransportBindingArtifact,
): Promise<boolean> {
  try {
    const unsigned = toUnsignedTransportBinding(artifact);
    const typedData = getTransportBindingTypedData(unsigned, toDomainOptions(artifact.proof));
    return await verifyTypedData({
      address: artifact.proof.signer,
      ...typedData,
      signature: artifact.proof.signature,
    });
  } catch {
    return false;
  }
}

async function verifyRevocationNoticeSignature(
  artifact: AgentCommSignedRevocationNoticeArtifact,
): Promise<boolean> {
  try {
    const unsigned = toUnsignedRevocationNotice(artifact);
    const typedData = getRevocationNoticeTypedData(unsigned, toDomainOptions(artifact.proof));
    return await verifyTypedData({
      address: artifact.proof.signer,
      ...typedData,
      signature: artifact.proof.signature,
    });
  } catch {
    return false;
  }
}

function ensureArtifactSignerMatchesIdentity(
  artifactType: "ContactCard" | "TransportBinding" | "RevocationNotice",
  signer: Address,
  identityWallet: Address,
): string[] {
  if (signer === identityWallet) {
    return [];
  }
  return [`bad signature: ${artifactType} proof signer must match identityWallet`];
}

function ensureExpectedChain(
  actualChainId: number,
  expectedChainId?: number,
): string[] {
  if (expectedChainId === undefined || actualChainId === expectedChainId) {
    return [];
  }
  return [`domain mismatch: expected chainId ${expectedChainId}, got ${actualChainId}`];
}

function ensureNotExpired(expiresAt: number, nowUnixSeconds: number): string[] {
  if (expiresAt > nowUnixSeconds) {
    return [];
  }
  return ["expired artifact"];
}

function assertPrivateKeyHex(value: string): Hex {
  const normalized = signatureHexSchema.parse(value);
  if (normalized.length !== 66) {
    throw new Error("signer private key must be a 32-byte hex value");
  }
  return normalized;
}

export async function signContactCardArtifact(input: {
  card: AgentCommContactCardInput;
  signerPrivateKey: string;
  domain?: AgentCommArtifactDomainOptions;
}): Promise<AgentCommSignedContactCardArtifact> {
  const card = contactCardSchema.parse(input.card);
  const signerPrivateKey = assertPrivateKeyHex(input.signerPrivateKey);
  const signer = privateKeyToAccount(signerPrivateKey);
  if (getAddress(signer.address) !== card.identityWallet) {
    throw new Error("ContactCard signer must match identityWallet");
  }

  const signature = await signer.signTypedData(getContactCardTypedData(card, input.domain));
  return signedContactCardArtifactSchema.parse({
    ...card,
    proof: {
      type: "eip712",
      signer: signer.address,
      signature,
      ...(input.domain?.salt ? { domain: { salt: input.domain.salt } } : {}),
    },
  });
}

export async function signTransportBindingArtifact(input: {
  binding: AgentCommTransportBindingInput;
  signerPrivateKey: string;
  domain?: AgentCommArtifactDomainOptions;
}): Promise<AgentCommSignedTransportBindingArtifact> {
  const binding = transportBindingSchema.parse(input.binding);
  const signerPrivateKey = assertPrivateKeyHex(input.signerPrivateKey);
  const signer = privateKeyToAccount(signerPrivateKey);
  if (getAddress(signer.address) !== binding.identityWallet) {
    throw new Error("TransportBinding signer must match identityWallet");
  }

  const signature = await signer.signTypedData(getTransportBindingTypedData(binding, input.domain));
  return signedTransportBindingArtifactSchema.parse({
    ...binding,
    proof: {
      type: "eip712",
      signer: signer.address,
      signature,
      ...(input.domain?.salt ? { domain: { salt: input.domain.salt } } : {}),
    },
  });
}

export async function signRevocationNoticeArtifact(input: {
  notice: AgentCommRevocationNoticeInput;
  signerPrivateKey: string;
  domain?: AgentCommArtifactDomainOptions;
}): Promise<AgentCommSignedRevocationNoticeArtifact> {
  const notice = revocationNoticeSchema.parse({
    ...input.notice,
    noticeVersion: input.notice.noticeVersion ?? AGENT_COMM_REVOCATION_NOTICE_VERSION,
  });
  const signerPrivateKey = assertPrivateKeyHex(input.signerPrivateKey);
  const signer = privateKeyToAccount(signerPrivateKey);
  if (getAddress(signer.address) !== notice.identityWallet) {
    throw new Error("RevocationNotice signer must match identityWallet");
  }

  const signature = await signer.signTypedData(getRevocationNoticeTypedData(notice, input.domain));
  return signedRevocationNoticeArtifactSchema.parse({
    ...notice,
    proof: {
      type: "eip712",
      signer: signer.address,
      signature,
      ...(input.domain?.salt ? { domain: { salt: input.domain.salt } } : {}),
    },
  });
}

export async function verifySignedContactCardArtifact(
  input: unknown,
  options: AgentCommArtifactVerificationOptions = {},
): Promise<AgentCommArtifactVerificationResult<AgentCommSignedContactCardArtifact>> {
  const artifact = signedContactCardArtifactSchema.parse(input);
  const nowUnixSeconds = nowUnixSecondsOrDefault(options.nowUnixSeconds);
  const signatureVerified = await verifyContactCardSignature(artifact);
  const digest = computeContactCardDigest(toUnsignedContactCard(artifact), toDomainOptions(artifact.proof));
  const errors = uniqueErrors([
    ...ensureArtifactSignerMatchesIdentity("ContactCard", artifact.proof.signer, artifact.identityWallet),
    ...ensureExpectedChain(artifact.transport.chainId, options.expectedChainId),
    ...ensureNotExpired(artifact.expiresAt, nowUnixSeconds),
    ...(signatureVerified ? [] : ["bad signature"]),
  ]);

  return {
    ok: errors.length === 0,
    errors,
    artifact,
    digest,
    fingerprint: formatArtifactFingerprint(digest),
    signatureVerified,
    signer: artifact.proof.signer,
  };
}

export async function verifySignedTransportBindingArtifact(
  input: unknown,
  options: AgentCommArtifactVerificationOptions = {},
): Promise<AgentCommArtifactVerificationResult<AgentCommSignedTransportBindingArtifact>> {
  const artifact = signedTransportBindingArtifactSchema.parse(input);
  const nowUnixSeconds = nowUnixSecondsOrDefault(options.nowUnixSeconds);
  const signatureVerified = await verifyTransportBindingSignature(artifact);
  const digest = computeTransportBindingDigest(
    toUnsignedTransportBinding(artifact),
    toDomainOptions(artifact.proof),
  );
  const errors = uniqueErrors([
    ...ensureArtifactSignerMatchesIdentity("TransportBinding", artifact.proof.signer, artifact.identityWallet),
    ...ensureExpectedChain(artifact.chainId, options.expectedChainId),
    ...ensureNotExpired(artifact.expiresAt, nowUnixSeconds),
    ...(signatureVerified ? [] : ["bad signature"]),
  ]);

  return {
    ok: errors.length === 0,
    errors,
    artifact,
    digest,
    fingerprint: formatArtifactFingerprint(digest),
    signatureVerified,
    signer: artifact.proof.signer,
  };
}

export async function verifyRevocationNoticeArtifact(
  input: unknown,
  options: AgentCommArtifactVerificationOptions = {},
): Promise<AgentCommArtifactVerificationResult<AgentCommSignedRevocationNoticeArtifact>> {
  const artifact = signedRevocationNoticeArtifactSchema.parse(input);
  const signatureVerified = await verifyRevocationNoticeSignature(artifact);
  const digest = computeRevocationNoticeDigest(
    toUnsignedRevocationNotice(artifact),
    toDomainOptions(artifact.proof),
  );
  const errors = uniqueErrors([
    ...ensureArtifactSignerMatchesIdentity("RevocationNotice", artifact.proof.signer, artifact.identityWallet),
    ...ensureExpectedChain(artifact.chainId, options.expectedChainId),
    ...(signatureVerified ? [] : ["bad signature"]),
  ]);

  return {
    ok: errors.length === 0,
    errors,
    artifact,
    digest,
    fingerprint: formatArtifactFingerprint(digest),
    signatureVerified,
    signer: artifact.proof.signer,
  };
}

export async function signIdentityArtifactBundle(input: {
  contactCard: AgentCommContactCardInput;
  transportBinding: AgentCommTransportBindingInput;
  signerPrivateKey: string;
  domain?: AgentCommArtifactDomainOptions;
  exportedAt?: number;
}): Promise<AgentCommSignedIdentityArtifactBundle> {
  const contactCard = contactCardSchema.parse(input.contactCard);
  const transportBinding = transportBindingSchema.parse(input.transportBinding);

  const consistencyErrors = collectTransportBindingConsistencyErrors(contactCard, transportBinding);
  if (consistencyErrors.length > 0) {
    throw new Error(consistencyErrors.join("; "));
  }

  const signedContactCard = await signContactCardArtifact({
    card: contactCard,
    signerPrivateKey: input.signerPrivateKey,
    domain: input.domain,
  });
  const signedTransportBinding = await signTransportBindingArtifact({
    binding: transportBinding,
    signerPrivateKey: input.signerPrivateKey,
    domain: input.domain,
  });

  return signedIdentityArtifactBundleSchema.parse({
    bundleVersion: AGENT_COMM_IDENTITY_ARTIFACT_BUNDLE_VERSION,
    exportedAt: input.exportedAt ?? Math.floor(Date.now() / 1000),
    contactCard: signedContactCard,
    transportBinding: signedTransportBinding,
  });
}

export async function verifySignedIdentityArtifactBundle(
  input: unknown,
  options: AgentCommArtifactVerificationOptions = {},
): Promise<AgentCommIdentityArtifactBundleVerificationResult> {
  const parsed = signedIdentityArtifactBundleSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: formatZodIssues(parsed.error),
    };
  }

  const bundle = parsed.data;
  const contactCard = await verifySignedContactCardArtifact(bundle.contactCard, options);
  const transportBinding = await verifySignedTransportBindingArtifact(bundle.transportBinding, options);
  const consistencyErrors = collectTransportBindingConsistencyErrors(
    contactCard.artifact,
    transportBinding.artifact,
  );

  const errors = uniqueErrors([
    ...contactCard.errors,
    ...transportBinding.errors,
    ...consistencyErrors,
  ]);

  return {
    ok: errors.length === 0,
    errors,
    contactCard,
    transportBinding,
    bundle,
  };
}

export function parseSignedIdentityArtifactBundle(rawJson: string): AgentCommSignedIdentityArtifactBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid artifact bundle JSON: ${reason}`);
  }

  return signedIdentityArtifactBundleSchema.parse(parsed);
}

export function parseSignedRevocationNoticeArtifact(rawJson: string): AgentCommSignedRevocationNoticeArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid revocation notice JSON: ${reason}`);
  }

  return signedRevocationNoticeArtifactSchema.parse(parsed);
}

export function buildLocalIdentityArtifacts(input: {
  identityWallet: string;
  transportAddress: string;
  transportPubkey: string;
  chainId: number;
  displayName: string;
  handle?: string;
  keyId: string;
  capabilityProfile?: string;
  capabilities?: string[];
  issuedAt: number;
  expiresAt: number;
  protocols?: string[];
  legacyPeerId?: string;
}): {
  contactCard: AgentCommContactCardInput;
  transportBinding: AgentCommTransportBindingInput;
} {
  const identityWallet = getAddress(input.identityWallet);
  const transportAddress = getAddress(input.transportAddress);
  const defaults: AgentCommContactCardDefaults = {
    capabilityProfile: input.capabilityProfile ?? "default",
    capabilities: input.capabilities ?? ["ping", "start_discovery"],
  };

  return {
    contactCard: {
      cardVersion: AGENT_COMM_CONTACT_CARD_VERSION,
      protocols: input.protocols ?? ["agent-comm/2", "agent-comm/1"],
      displayName: input.displayName,
      handle: input.handle ?? "",
      identityWallet,
      transport: {
        chainId: input.chainId,
        receiveAddress: transportAddress,
        pubkey: input.transportPubkey,
        keyId: input.keyId,
      },
      defaults,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      legacyPeerId: input.legacyPeerId ?? "",
    },
    transportBinding: {
      bindingVersion: AGENT_COMM_TRANSPORT_BINDING_VERSION,
      identityWallet,
      chainId: input.chainId,
      receiveAddress: transportAddress,
      pubkey: input.transportPubkey,
      keyId: input.keyId,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    },
  };
}

export type AgentCommArtifactProof = z.infer<typeof agentCommArtifactProofSchema>;
export type AgentCommSignedContactCardArtifact = z.infer<typeof signedContactCardArtifactSchema>;
export type AgentCommSignedTransportBindingArtifact = z.infer<
  typeof signedTransportBindingArtifactSchema
>;
export type AgentCommSignedRevocationNoticeArtifact = z.infer<typeof signedRevocationNoticeArtifactSchema>;
export type AgentCommSignedIdentityArtifactBundle = z.infer<typeof signedIdentityArtifactBundleSchema>;
