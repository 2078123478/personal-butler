import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { type X402Proof } from "../src/skills/alphaos/runtime/agent-comm/types";
import {
  buildX402SigningPayload,
  verifyX402Proof,
} from "../src/skills/alphaos/runtime/agent-comm/x402-adapter";
import { restoreShadowWallet } from "../src/skills/alphaos/runtime/agent-comm/shadow-wallet";
import { StateStore } from "../src/skills/alphaos/runtime/state-store";

const PAYER_PRIVATE_KEY =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_PRIVATE_KEY =
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const LOCAL_PRIVATE_KEY =
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

const payerWallet = restoreShadowWallet(PAYER_PRIVATE_KEY);
const localWallet = restoreShadowWallet(LOCAL_PRIVATE_KEY);
const otherWallet = restoreShadowWallet(OTHER_PRIVATE_KEY);

const stores: Array<{ dir: string; store: StateStore }> = [];

function createStore(prefix: string): StateStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = new StateStore(dir);
  stores.push({ dir, store });
  return store;
}

async function buildSignedProof(input: {
  signerPrivateKey: `0x${string}`;
  payer: string;
  payee?: string;
  asset?: string;
  amount?: string;
  nonce?: string;
  expiresAt?: string;
}): Promise<X402Proof> {
  const signer = privateKeyToAccount(input.signerPrivateKey);
  const proof: X402Proof = {
    scheme: "x402",
    payer: input.payer,
    payee: input.payee,
    asset: input.asset ?? "USDC",
    amount: input.amount ?? "1000000",
    nonce: input.nonce ?? "nonce-x402-1",
    expiresAt: input.expiresAt ?? "2026-04-08T00:00:00.000Z",
  };
  return {
    ...proof,
    signature: await signer.signMessage({
      message: buildX402SigningPayload(proof),
    }),
  };
}

afterEach(() => {
  for (const { dir, store } of stores.splice(0)) {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("verifyX402Proof", () => {
  it("accepts valid x402 proofs with matching signer and payee", async () => {
    const store = createStore("alphaos-x402-");
    const proof = await buildSignedProof({
      signerPrivateKey: PAYER_PRIVATE_KEY,
      payer: payerWallet.getAddress(),
      payee: localWallet.getAddress(),
    });

    const result = await verifyX402Proof(
      {
        mode: "enforce",
        store,
        localPayees: [localWallet.getAddress()],
        expectedPayment: {
          asset: "USDC",
          amount: "1000000",
        },
        now: new Date("2026-03-08T00:00:00.000Z"),
      },
      proof,
    );

    expect(result.valid).toBe(true);
    expect(result.payer).toBe(payerWallet.getAddress());
    expect(result.payee).toBe(localWallet.getAddress());
  });

  it("rejects proof when recovered signer does not match payer", async () => {
    const store = createStore("alphaos-x402-");
    const proof = await buildSignedProof({
      signerPrivateKey: OTHER_PRIVATE_KEY,
      payer: payerWallet.getAddress(),
      payee: localWallet.getAddress(),
    });

    const result = await verifyX402Proof(
      {
        mode: "observe",
        store,
        localPayees: [localWallet.getAddress()],
        now: new Date("2026-03-08T00:00:00.000Z"),
      },
      proof,
    );

    expect(result.valid).toBe(false);
    expect(result.error).toContain("payer does not match recovered signer");
  });

  it("rejects expired proofs", async () => {
    const store = createStore("alphaos-x402-");
    const proof = await buildSignedProof({
      signerPrivateKey: PAYER_PRIVATE_KEY,
      payer: payerWallet.getAddress(),
      payee: localWallet.getAddress(),
      expiresAt: "2026-03-01T00:00:00.000Z",
    });

    const result = await verifyX402Proof(
      {
        mode: "observe",
        store,
        localPayees: [localWallet.getAddress()],
        now: new Date("2026-03-08T00:00:00.000Z"),
      },
      proof,
    );

    expect(result.valid).toBe(false);
    expect(result.error).toContain("proof expired");
  });

  it("rejects proof when payee does not match local address", async () => {
    const store = createStore("alphaos-x402-");
    const proof = await buildSignedProof({
      signerPrivateKey: PAYER_PRIVATE_KEY,
      payer: payerWallet.getAddress(),
      payee: otherWallet.getAddress(),
    });

    const result = await verifyX402Proof(
      {
        mode: "observe",
        store,
        localPayees: [localWallet.getAddress()],
        now: new Date("2026-03-08T00:00:00.000Z"),
      },
      proof,
    );

    expect(result.valid).toBe(false);
    expect(result.error).toContain("payee does not match local receive address");
  });

  it("rejects proofs missing required fields", async () => {
    const store = createStore("alphaos-x402-");
    const proof = {
      scheme: "x402",
      payer: payerWallet.getAddress(),
      asset: "USDC",
      amount: "1000000",
      signature: "0x1234",
    } as X402Proof;

    const result = await verifyX402Proof(
      {
        mode: "observe",
        store,
        localPayees: [localWallet.getAddress()],
      },
      proof,
    );

    expect(result.valid).toBe(false);
    expect(result.error).toContain("missing required field: nonce");
  });
});
