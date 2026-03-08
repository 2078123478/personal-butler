import type { StateStore } from "../state-store";
import type {
  AgentCommSignedContactCardArtifact,
  AgentCommSignedTransportBindingArtifact,
} from "./artifact-workflow";

export function persistSignedContactCardArtifact(
  store: StateStore,
  artifact: AgentCommSignedContactCardArtifact,
  options: {
    digest: string;
    source: string;
    verificationStatus: "verified" | "invalid";
    verificationError?: string;
  },
): void {
  store.upsertAgentSignedArtifact({
    artifactType: "ContactCard",
    digest: options.digest,
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
    verificationStatus: options.verificationStatus,
    verificationError: options.verificationError,
    source: options.source,
  });
}

export function persistSignedTransportBindingArtifact(
  store: StateStore,
  artifact: AgentCommSignedTransportBindingArtifact,
  options: {
    digest: string;
    source: string;
    verificationStatus: "verified" | "invalid";
    verificationError?: string;
  },
): void {
  store.upsertAgentSignedArtifact({
    artifactType: "TransportBinding",
    digest: options.digest,
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
    verificationStatus: options.verificationStatus,
    verificationError: options.verificationError,
    source: options.source,
  });
}
