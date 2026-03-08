import type { AgentCommSignedIdentityArtifactBundle } from "./artifact-workflow";

export const AGENT_COMM_CARD_SHARE_SCHEME = "agentcomm://card";
export const AGENT_COMM_CARD_SHARE_VERSION = 1;

function parseUrlHashParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
}

function readBundleParam(url: URL): string | null {
  return url.searchParams.get("bundle") ?? parseUrlHashParams(url.hash).get("bundle");
}

function readVersionParam(url: URL): number | undefined {
  const raw = url.searchParams.get("v") ?? parseUrlHashParams(url.hash).get("v");
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function buildIdentityArtifactBundleShareUrl(
  bundle: AgentCommSignedIdentityArtifactBundle,
): string {
  const encodedBundle = Buffer.from(JSON.stringify(bundle), "utf8").toString("base64url");
  return `${AGENT_COMM_CARD_SHARE_SCHEME}?v=${AGENT_COMM_CARD_SHARE_VERSION}&bundle=${encodedBundle}`;
}

export function tryDecodeIdentityArtifactBundleShareUrl(input: string): {
  rawJson: string;
  shareUrl: string;
} | null {
  const candidate = input.trim();
  if (!candidate.includes("://")) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol === "agentcomm:" && url.hostname !== "card") {
    return null;
  }

  if (!["agentcomm:", "https:", "http:"].includes(url.protocol)) {
    return null;
  }

  const encodedBundle = readBundleParam(url);
  if (!encodedBundle) {
    return null;
  }

  const version = readVersionParam(url) ?? AGENT_COMM_CARD_SHARE_VERSION;
  if (version !== AGENT_COMM_CARD_SHARE_VERSION) {
    throw new Error(
      `Unsupported agent-comm card share version: ${version} (expected ${AGENT_COMM_CARD_SHARE_VERSION})`,
    );
  }

  try {
    return {
      rawJson: Buffer.from(encodedBundle, "base64url").toString("utf8"),
      shareUrl: candidate,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid agent-comm card share payload: ${reason}`);
  }
}
