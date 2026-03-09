import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  AGENT_COMM_EMPTY_ARTIFACT_DIGEST,
  AGENT_COMM_REVOCATION_NOTICE_VERSION,
  computeTransportBindingDigest,
} from "../src/skills/alphaos/runtime/agent-comm/artifact-contracts";
import {
  buildLocalIdentityArtifacts,
  parseSignedRevocationNoticeArtifact,
  signContactCardArtifact,
  signIdentityArtifactBundle,
  signRevocationNoticeArtifact,
  signTransportBindingArtifact,
  verifyRevocationNoticeArtifact,
  verifySignedIdentityArtifactBundle,
} from "../src/skills/alphaos/runtime/agent-comm/artifact-workflow";

const identityPrivateKey =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const account = privateKeyToAccount(identityPrivateKey);
const nowUnixSeconds = 1741348800;

function buildBaseArtifacts() {
  return buildLocalIdentityArtifacts({
    identityWallet: account.address,
    transportAddress: "0x2222222222222222222222222222222222222222",
    transportPubkey: "0x02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    chainId: 196,
    displayName: "Xiaoyin",
    handle: "@xiaoyin",
    keyId: "rk_2026_01",
    capabilityProfile: "research-collab",
    capabilities: ["ping", "start_discovery"],
    issuedAt: nowUnixSeconds,
    expiresAt: nowUnixSeconds + 60 * 60 * 24 * 180,
    protocols: ["agent-comm/2", "agent-comm/1"],
    legacyPeerId: "",
  });
}

describe("agent-comm artifact workflow", () => {
  it("signs and verifies a contact card + transport binding bundle", async () => {
    const artifacts = buildBaseArtifacts();
    const bundle = await signIdentityArtifactBundle({
      ...artifacts,
      signerPrivateKey: identityPrivateKey,
      exportedAt: nowUnixSeconds,
    });

    const verification = await verifySignedIdentityArtifactBundle(bundle, {
      expectedChainId: 196,
      nowUnixSeconds,
    });

    expect(verification.ok).toBe(true);
    expect(verification.errors).toEqual([]);
    expect(verification.contactCard?.fingerprint).toMatch(/^0x[0-9a-f]{8}\.\.\.[0-9a-f]{8}$/);
    expect(verification.transportBinding?.fingerprint).toMatch(/^0x[0-9a-f]{8}\.\.\.[0-9a-f]{8}$/);
  });

  it("reports malformed transport binding when card and binding diverge", async () => {
    const artifacts = buildBaseArtifacts();
    const signedContactCard = await signContactCardArtifact({
      card: artifacts.contactCard,
      signerPrivateKey: identityPrivateKey,
    });
    const signedTransportBinding = await signTransportBindingArtifact({
      binding: {
        ...artifacts.transportBinding,
        receiveAddress: "0x3333333333333333333333333333333333333333",
      },
      signerPrivateKey: identityPrivateKey,
    });

    const verification = await verifySignedIdentityArtifactBundle({
      bundleVersion: 1,
      exportedAt: nowUnixSeconds,
      contactCard: signedContactCard,
      transportBinding: signedTransportBinding,
    });

    expect(verification.ok).toBe(false);
    expect(verification.errors.some((reason) => reason.includes("malformed transport binding"))).toBe(
      true,
    );
  });

  it("reports bad signature, expiry, and domain mismatch reasons", async () => {
    const artifacts = buildBaseArtifacts();
    const bundle = await signIdentityArtifactBundle({
      ...artifacts,
      signerPrivateKey: identityPrivateKey,
      exportedAt: nowUnixSeconds,
    });
    const tamperedBundle = {
      ...bundle,
      contactCard: {
        ...bundle.contactCard,
        displayName: "Tampered",
      },
    };

    const verification = await verifySignedIdentityArtifactBundle(tamperedBundle, {
      expectedChainId: 8453,
      nowUnixSeconds: artifacts.contactCard.expiresAt + 1,
    });

    expect(verification.ok).toBe(false);
    expect(verification.errors).toContain("bad signature");
    expect(verification.errors).toContain("expired artifact");
    expect(verification.errors.some((reason) => reason.includes("domain mismatch"))).toBe(true);
  });

  it("signs and verifies a revocation notice artifact", async () => {
    const artifacts = buildBaseArtifacts();
    const bindingDigest = computeTransportBindingDigest(artifacts.transportBinding);
    const signed = await signRevocationNoticeArtifact({
      notice: {
        noticeVersion: AGENT_COMM_REVOCATION_NOTICE_VERSION,
        identityWallet: account.address,
        chainId: 196,
        artifactType: "TransportBinding",
        artifactDigest: bindingDigest,
        replacementDigest: AGENT_COMM_EMPTY_ARTIFACT_DIGEST,
        reason: "rotated transport key",
        revokedAt: nowUnixSeconds + 60,
      },
      signerPrivateKey: identityPrivateKey,
    });

    const verification = await verifyRevocationNoticeArtifact(signed, {
      expectedChainId: 196,
    });

    expect(verification.ok).toBe(true);
    expect(verification.errors).toEqual([]);
    expect(verification.digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(verification.fingerprint).toMatch(/^0x[0-9a-f]{8}\.\.\.[0-9a-f]{8}$/);
    expect(parseSignedRevocationNoticeArtifact(JSON.stringify(signed))).toEqual(signed);
  });

  it("reports revocation notice domain mismatch and bad signature", async () => {
    const artifacts = buildBaseArtifacts();
    const signed = await signRevocationNoticeArtifact({
      notice: {
        noticeVersion: AGENT_COMM_REVOCATION_NOTICE_VERSION,
        identityWallet: account.address,
        chainId: 196,
        artifactType: "ContactCard",
        artifactDigest: computeTransportBindingDigest(artifacts.transportBinding),
        replacementDigest: AGENT_COMM_EMPTY_ARTIFACT_DIGEST,
        reason: "",
        revokedAt: nowUnixSeconds + 120,
      },
      signerPrivateKey: identityPrivateKey,
    });

    const tampered = {
      ...signed,
      reason: "tampered",
    };
    const verification = await verifyRevocationNoticeArtifact(tampered, {
      expectedChainId: 8453,
    });
    expect(verification.ok).toBe(false);
    expect(verification.errors).toContain("bad signature");
    expect(verification.errors.some((reason) => reason.includes("domain mismatch"))).toBe(true);
  });
});
