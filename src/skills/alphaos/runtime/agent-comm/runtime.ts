import type { Logger } from "pino";
import { createPublicClient, http } from "viem";
import type { AlphaOsConfig } from "../config";
import type { DiscoveryEngine } from "../discovery/discovery-engine";
import type { OnchainOsClient } from "../onchainos-client";
import type { StateStore } from "../state-store";
import type { VaultService } from "../vault";
import {
  processInbox,
  InboxProcessingError,
  type ProcessInboxResult,
} from "./inbox-processor";
import { restoreShadowWallet } from "./shadow-wallet";
import { routeCommand } from "./task-router";
import { startListener, type TransactionEvent } from "./tx-listener";
import type { CommListenerMode, ListenerCursor } from "./types";

export interface AgentCommRuntimeErrorSnapshot {
  code: string;
  message: string;
  at: string;
  details?: Record<string, unknown>;
}

export interface AgentCommRuntimeSnapshot {
  enabled: boolean;
  chainId: number;
  listenerMode: CommListenerMode;
  walletAlias: string;
  localAddress?: string;
  localPubkey?: string;
  lastCursor?: ListenerCursor;
  lastRuntimeError?: AgentCommRuntimeErrorSnapshot;
}

export interface AgentCommRuntimeHandle {
  stop(): void;
  getSnapshot(): AgentCommRuntimeSnapshot;
}

export interface StartAgentCommRuntimeOptions {
  config: AlphaOsConfig;
  logger: Logger;
  store: StateStore;
  discovery: DiscoveryEngine;
  onchain: OnchainOsClient;
  vault: VaultService;
}

interface AgentCommRuntimeState {
  localAddress?: string;
  localPubkey?: string;
  lastRuntimeError?: AgentCommRuntimeErrorSnapshot;
}

interface RestoredRuntimeWallet {
  wallet: ReturnType<typeof restoreShadowWallet>;
  address: string;
  pubkey: string;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertRuntimeConfig(config: AlphaOsConfig): void {
  if (!config.commEnabled) {
    return;
  }
  if (!config.commRpcUrl) {
    throw new Error("COMM_ENABLED=true requires COMM_RPC_URL");
  }
  if (config.commListenerMode === "ws") {
    throw new Error("COMM_LISTENER_MODE=ws is not supported in agent-comm v0.1");
  }
}

function createSnapshotGetter(
  config: AlphaOsConfig,
  store: StateStore,
  state: AgentCommRuntimeState,
): () => AgentCommRuntimeSnapshot {
  return () => ({
    enabled: config.commEnabled,
    chainId: config.commChainId,
    listenerMode: config.commListenerMode,
    walletAlias: config.commWalletAlias,
    localAddress: state.localAddress,
    localPubkey: state.localPubkey,
    lastCursor: state.localAddress
      ? (store.getListenerCursor(state.localAddress, config.commChainId) ?? undefined)
      : undefined,
    lastRuntimeError: state.lastRuntimeError,
  });
}

async function assertRpcChainId(rpcUrl: string, chainId: number): Promise<void> {
  const client = createPublicClient({
    transport: http(rpcUrl),
  });
  const actualChainId = await client.getChainId();
  if (actualChainId !== chainId) {
    throw new Error(`RPC chainId mismatch: expected ${chainId}, received ${actualChainId}`);
  }
}

function createRuntimeState(): AgentCommRuntimeState {
  return {};
}

function createDisabledRuntimeHandle(
  getSnapshot: () => AgentCommRuntimeSnapshot,
): AgentCommRuntimeHandle {
  return {
    stop() {},
    getSnapshot,
  };
}

function getRequiredMasterPassword(): string {
  const masterPassword = process.env.VAULT_MASTER_PASSWORD;
  if (!masterPassword) {
    throw new Error("COMM_ENABLED=true requires VAULT_MASTER_PASSWORD");
  }
  return masterPassword;
}

function getRequiredRpcUrl(config: AlphaOsConfig): string {
  if (!config.commRpcUrl) {
    throw new Error("COMM_ENABLED=true requires COMM_RPC_URL");
  }
  return config.commRpcUrl;
}

function restoreRuntimeWallet(
  options: StartAgentCommRuntimeOptions,
  masterPassword: string,
  state: AgentCommRuntimeState,
): RestoredRuntimeWallet {
  const privateKey = options.vault.getSecret(options.config.commWalletAlias, masterPassword);
  const wallet = restoreShadowWallet(privateKey);
  const address = wallet.getAddress();
  const pubkey = wallet.getPublicKey();

  state.localAddress = address;
  state.localPubkey = pubkey;

  return {
    wallet,
    address,
    pubkey,
  };
}

function createRuntimeErrorRecorder(
  logger: Logger,
  state: AgentCommRuntimeState,
): (code: string, message: string, details?: Record<string, unknown>) => void {
  return (code: string, message: string, details?: Record<string, unknown>): void => {
    state.lastRuntimeError = {
      code,
      message,
      at: new Date().toISOString(),
      details,
    };
    logger.error(
      {
        code,
        details,
      },
      message,
    );
  };
}

function shouldExecuteMessage(result: ProcessInboxResult): boolean {
  if (result.message.status === "executed" || result.message.status === "rejected") {
    return false;
  }
  return result.message.status === "decrypted";
}

async function executeInboundMessage(
  options: Pick<StartAgentCommRuntimeOptions, "discovery" | "onchain" | "store">,
  result: ProcessInboxResult,
): Promise<void> {
  if (!shouldExecuteMessage(result)) {
    return;
  }

  const routeResult = await routeCommand(
    {
      discovery: options.discovery,
      onchain: options.onchain,
      store: options.store,
    },
    result.command,
  );

  if (routeResult.success) {
    options.store.updateAgentMessageStatus(result.message.id, "executed", {
      executedAt: new Date().toISOString(),
    });
    return;
  }

  options.store.updateAgentMessageStatus(result.message.id, "rejected", {
    executedAt: new Date().toISOString(),
    error: routeResult.error ?? "command rejected",
  });
}

function createTransactionHandler(
  options: Pick<StartAgentCommRuntimeOptions, "config" | "discovery" | "onchain" | "store">,
  wallet: ReturnType<typeof restoreShadowWallet>,
  setRuntimeError: (code: string, message: string, details?: Record<string, unknown>) => void,
): (event: TransactionEvent) => Promise<void> {
  return async (event: TransactionEvent): Promise<void> => {
    try {
      const result = await processInbox(
        {
          wallet,
          store: options.store,
          expectedChainId: options.config.commChainId,
        },
        event,
      );

      await executeInboundMessage(options, result);
    } catch (error) {
      if (error instanceof InboxProcessingError) {
        setRuntimeError(error.code, error.message, error.details);
        return;
      }
      setRuntimeError("INBOUND_RUNTIME_FAILED", toErrorMessage(error), {
        txHash: event.txHash,
      });
    }
  };
}

function startRuntimeListener(
  config: AlphaOsConfig,
  logger: Logger,
  store: StateStore,
  localAddress: string,
  rpcUrl: string,
  handleTransaction: (event: TransactionEvent) => Promise<void>,
  setRuntimeError: (code: string, message: string, details?: Record<string, unknown>) => void,
): () => void {
  if (config.commListenerMode !== "poll") {
    logger.warn(
      {
        chainId: config.commChainId,
        listenerMode: config.commListenerMode,
      },
      "agent-comm runtime started without listener",
    );
    return () => {};
  }

  const stopListener = startListener(
    {
      rpcUrl,
      chainId: config.commChainId,
      address: localAddress,
      pollIntervalMs: config.commPollIntervalMs,
      store,
      mode: "poll",
      onError: (error) => {
        setRuntimeError("LISTENER_FAILED", error.message, {
          chainId: config.commChainId,
          address: localAddress,
        });
      },
    },
    handleTransaction,
  );

  logger.info(
    {
      chainId: config.commChainId,
      address: localAddress,
      listenerMode: config.commListenerMode,
    },
    "agent-comm runtime started",
  );

  return stopListener;
}

function createRuntimeHandle(
  stopListener: () => void,
  getSnapshot: () => AgentCommRuntimeSnapshot,
): AgentCommRuntimeHandle {
  let stopped = false;

  return {
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      stopListener();
    },
    getSnapshot,
  };
}

export async function startAgentCommRuntime(
  options: StartAgentCommRuntimeOptions,
): Promise<AgentCommRuntimeHandle> {
  const { config, logger, store } = options;
  assertRuntimeConfig(config);

  const runtimeState = createRuntimeState();
  const getSnapshot = createSnapshotGetter(config, store, runtimeState);

  if (!config.commEnabled) {
    return createDisabledRuntimeHandle(getSnapshot);
  }

  const rpcUrl = getRequiredRpcUrl(config);
  const masterPassword = getRequiredMasterPassword();
  const restoredWallet = restoreRuntimeWallet(options, masterPassword, runtimeState);

  await assertRpcChainId(rpcUrl, config.commChainId);

  const setRuntimeError = createRuntimeErrorRecorder(logger, runtimeState);
  const handleTransaction = createTransactionHandler(
    {
      config,
      discovery: options.discovery,
      onchain: options.onchain,
      store,
    },
    restoredWallet.wallet,
    setRuntimeError,
  );
  const stopListener = startRuntimeListener(
    config,
    logger,
    store,
    restoredWallet.address,
    rpcUrl,
    handleTransaction,
    setRuntimeError,
  );

  return createRuntimeHandle(stopListener, getSnapshot);
}
