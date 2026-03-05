import crypto from "node:crypto";
import type {
  ExecutionPlan,
  OnchainIntegrationStatus,
  OnchainProbeResult,
  OnchainV6BroadcastResponse,
  OnchainV6QuoteRequest,
  OnchainV6QuoteResponse,
  OnchainV6SimulateResponse,
  OnchainV6SwapRequest,
  OnchainV6SwapResponse,
  Quote,
  TokenResolution,
  TradeResult,
} from "../types";
import { StateStore } from "./state-store";

type AuthMode = "bearer" | "api-key" | "hmac";

type QuoteWire = {
  fromTokenAmount?: string;
  toTokenAmount?: string;
  estimateGasFee?: string;
  tradeFee?: string;
  dexRouterList?: Array<{
    dexName?: string;
    fromTokenAmount?: string;
    toTokenAmount?: string;
  }>;
};

interface OnchainClientOptions {
  apiBase?: string;
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
  projectId?: string;
  authMode: AuthMode;
  apiKeyHeader: string;
  gasUsdDefault: number;
  chainIndex: string;
  requireSimulate: boolean;
  enableCompatFallback: boolean;
  tokenCacheTtlSeconds: number;
  tokenProfilePath: string;
  store?: StateStore;
}

class OnchainApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly path?: string,
  ) {
    super(message);
  }

  get isRestricted(): boolean {
    if (this.status === 401 || this.status === 403) {
      return true;
    }
    const text = `${this.code ?? ""} ${this.message}`.toLowerCase();
    return text.includes("whitelist") || text.includes("permission") || text.includes("unauthorized");
  }
}

function seededNoise(seed: string): number {
  const hash = crypto.createHash("sha256").update(seed).digest();
  return hash.readUInt16BE(0) / 65535;
}

function toNumber(input: unknown, fallback = 0): number {
  const value = Number(input);
  return Number.isFinite(value) ? value : fallback;
}

function splitPair(pair: string): { base: string; quote: string } {
  const [baseRaw, quoteRaw] = pair.toUpperCase().split("/");
  return {
    base: (baseRaw ?? "ETH").trim(),
    quote: (quoteRaw ?? "USDC").trim(),
  };
}

const V6_PATHS = {
  quote: ["/api/v6/dex/aggregator/quote"],
  swap: ["/api/v6/dex/aggregator/swap"],
  history: ["/api/v6/dex/aggregator/history"],
  simulate: ["/api/v6/dex/pre-transaction/simulate"],
  broadcast: ["/api/v6/dex/pre-transaction/broadcast-transaction"],
};

const LEGACY_PATHS = {
  quote: ["/market/quote", "/api/v1/market/quote", "/dex/quote"],
  swap: ["/trade/arbitrage", "/api/v1/trade/arbitrage", "/swap/arbitrage"],
  history: ["/api/v1/trade/history"],
  simulate: ["/api/v1/trade/simulate"],
  broadcast: ["/api/v1/trade/broadcast"],
};

export class OnchainOsClient {
  private diagnostics: OnchainIntegrationStatus;

  constructor(private readonly options: OnchainClientOptions) {
    this.diagnostics = {
      authMode: options.authMode,
      v6Preferred: true,
      compatFallbackEnabled: options.enableCompatFallback,
      requireSimulate: options.requireSimulate,
      tokenProfilePath: options.tokenProfilePath,
      chainIndex: options.chainIndex,
    };
  }

  getIntegrationStatus(): OnchainIntegrationStatus {
    return { ...this.diagnostics };
  }

  getTokenCacheEntry(symbol: string, chainIndex = this.options.chainIndex) {
    if (!this.options.store) {
      return null;
    }
    return this.options.store.getTokenCache(symbol.toUpperCase(), chainIndex);
  }

  async probeConnection(input?: {
    pair?: string;
    chainIndex?: string;
    notionalUsd?: number;
    userWalletAddress?: string;
  }): Promise<OnchainProbeResult> {
    const checkedAt = new Date().toISOString();
    const pair = (input?.pair ?? "ETH/USDC").toUpperCase();
    const chainIndex = input?.chainIndex ?? this.options.chainIndex;
    const notionalUsdRaw = toNumber(input?.notionalUsd, 25);
    const notionalUsd = Math.max(1, Number(notionalUsdRaw.toFixed(4)));
    const userWalletAddress =
      input?.userWalletAddress && input.userWalletAddress.trim()
        ? input.userWalletAddress.trim()
        : "0x1111111111111111111111111111111111111111";

    if (!this.options.apiBase) {
      return {
        ok: false,
        configured: false,
        mode: "mock",
        pair,
        chainIndex,
        notionalUsd,
        simulateRequired: this.options.requireSimulate,
        message: "ONCHAINOS_API_BASE not configured; running in mock mode",
        checkedAt,
      };
    }

    let quotePath: string | undefined;
    let swapPath: string | undefined;
    let simulatePath: string | undefined;

    try {
      const quoteToken = await this.resolveToken(pair, "quote", chainIndex);
      const baseToken = await this.resolveToken(pair, "base", chainIndex);
      const amount = String(Math.max(1, Math.floor(notionalUsd * 10 ** Math.min(quoteToken.decimals, 6))));

      await this.getQuoteV6({
        chainIndex,
        fromTokenAddress: quoteToken.address,
        toTokenAddress: baseToken.address,
        amount,
      });
      quotePath = this.diagnostics.lastUsedPath;

      const swap = await this.buildSwapV6({
        chainIndex,
        fromTokenAddress: quoteToken.address,
        toTokenAddress: baseToken.address,
        amount,
        userWalletAddress,
        slippage: "0.5",
      });
      swapPath = this.diagnostics.lastUsedPath;

      if (this.options.requireSimulate) {
        const simulate = await this.simulateV6({
          chainIndex,
          txData: swap.txData,
          to: swap.to,
          value: swap.value,
          userWalletAddress,
        });
        simulatePath = this.diagnostics.lastUsedPath;
        if (!simulate.success) {
          return {
            ok: false,
            configured: true,
            mode: "v6",
            pair,
            chainIndex,
            notionalUsd,
            quotePath,
            swapPath,
            simulatePath,
            simulateRequired: this.options.requireSimulate,
            failureStep: "simulate",
            message: simulate.message ?? "simulate returned failed",
            checkedAt,
          };
        }
      }

      return {
        ok: true,
        configured: true,
        mode: "v6",
        pair,
        chainIndex,
        notionalUsd,
        quotePath,
        swapPath,
        simulatePath,
        simulateRequired: this.options.requireSimulate,
        message: "v6 probe passed",
        checkedAt,
      };
    } catch (error) {
      this.recordError(error);
      return {
        ok: false,
        configured: true,
        mode: "v6",
        pair,
        chainIndex,
        notionalUsd,
        quotePath,
        swapPath,
        simulatePath,
        simulateRequired: this.options.requireSimulate,
        failureStep: this.getProbeFailureStep(error),
        message: String(error),
        checkedAt,
      };
    }
  }

  async resolveToken(
    pair: string,
    side: "base" | "quote",
    chainIndex = this.options.chainIndex,
  ): Promise<TokenResolution> {
    const { base, quote } = splitPair(pair);
    const symbol = side === "base" ? base : quote;

    const cached = this.options.store?.getTokenCache(symbol, chainIndex);
    if (cached && new Date(cached.expiresAt).getTime() > Date.now()) {
      return {
        symbol,
        chainIndex,
        address: cached.address,
        decimals: cached.decimals,
        source: "cache",
        updatedAt: cached.updatedAt,
      };
    }

    try {
      const remote = await this.fetchTokenProfile(symbol, chainIndex);
      const expiresAt = new Date(Date.now() + this.options.tokenCacheTtlSeconds * 1000).toISOString();
      this.options.store?.upsertTokenCache({
        symbol,
        chainIndex,
        address: remote.address,
        decimals: remote.decimals,
        expiresAt,
      });
      return {
        symbol,
        chainIndex,
        address: remote.address,
        decimals: remote.decimals,
        source: "remote",
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (cached) {
        return {
          symbol,
          chainIndex,
          address: cached.address,
          decimals: cached.decimals,
          source: "cache",
          updatedAt: cached.updatedAt,
        };
      }
      throw error;
    }
  }

  async getQuotes(pair: string, dexes: string[]): Promise<Quote[]> {
    if (!this.options.apiBase) {
      return this.getMockQuotes(pair, dexes);
    }

    const quoteToken = await this.resolveToken(pair, "quote", this.options.chainIndex);
    const baseToken = await this.resolveToken(pair, "base", this.options.chainIndex);
    const amount = String(Math.max(1, Math.floor(100 * 10 ** Math.min(quoteToken.decimals, 6))));

    const quotes: Quote[] = [];
    for (const dex of dexes) {
      try {
        const quote = await this.getQuoteV6({
          chainIndex: this.options.chainIndex,
          fromTokenAddress: quoteToken.address,
          toTokenAddress: baseToken.address,
          amount,
          dexIds: dex,
        });

        const from = toNumber(quote.fromTokenAmount, 1);
        const to = toNumber(quote.toTokenAmount, 1);
        const basePrice = from > 0 && to > 0 ? from / to : 0;
        const midpoint = basePrice > 0 ? basePrice : 3000;
        const halfSpread = midpoint * 0.00085;
        quotes.push({
          pair,
          dex,
          bid: Number((midpoint - halfSpread).toFixed(6)),
          ask: Number((midpoint + halfSpread).toFixed(6)),
          gasUsd: Math.max(0.5, toNumber(quote.estimateGasFee, this.options.gasUsdDefault)),
          ts: new Date().toISOString(),
        });
      } catch (error) {
        this.recordError(error);
      }
    }

    if (quotes.length === 0) {
      return this.getMockQuotes(pair, dexes);
    }
    return quotes;
  }

  async executePlan(plan: ExecutionPlan): Promise<TradeResult> {
    if (!this.options.apiBase) {
      return this.mockTrade(plan);
    }

    try {
      return await this.executeDualLeg(plan);
    } catch (error) {
      this.recordError(error);
      const apiError = error as OnchainApiError;
      if (apiError instanceof OnchainApiError && apiError.isRestricted) {
        return {
          success: false,
          txHash: "",
          status: "failed",
          grossUsd: 0,
          feeUsd: 0,
          netUsd: 0,
          error: apiError.message,
          errorType: apiError.message.toLowerCase().includes("whitelist")
            ? "whitelist_restricted"
            : "permission_denied",
        };
      }
      const knownValidationCode =
        apiError instanceof OnchainApiError &&
        ["ROUTE_MISMATCH", "SIMULATE_FAILED", "SELL_AMOUNT_INVALID", "DUAL_LEG_PARTIAL"].includes(
          apiError.code ?? "",
        );
      return {
        success: false,
        txHash: "",
        status: "failed",
        grossUsd: 0,
        feeUsd: 0,
        netUsd: 0,
        error: String(error),
        errorType: knownValidationCode ? "validation" : apiError instanceof OnchainApiError ? "network" : "unknown",
      };
    }
  }

  async executeDualLeg(plan: ExecutionPlan): Promise<TradeResult> {
    const startedAt = Date.now();
    const quoteToken = await this.resolveToken(plan.pair, "quote", this.options.chainIndex);
    const baseToken = await this.resolveToken(plan.pair, "base", this.options.chainIndex);
    const buyAmountRaw = Math.max(1, Math.floor(plan.notionalUsd * 10 ** Math.min(quoteToken.decimals, 6)));
    const userWalletAddress =
      typeof plan.metadata?.userWalletAddress === "string" && plan.metadata.userWalletAddress
        ? plan.metadata.userWalletAddress
        : "0x1111111111111111111111111111111111111111";

    const buyLeg = await this.executeLeg({
      chainIndex: this.options.chainIndex,
      fromTokenAddress: quoteToken.address,
      toTokenAddress: baseToken.address,
      amount: String(buyAmountRaw),
      dexId: plan.buyDex,
      userWalletAddress,
      leg: "buy",
    });

    const sellAmount = Math.max(1, Math.floor(toNumber(buyLeg.quote.toTokenAmount, 0)));
    if (!Number.isFinite(sellAmount) || sellAmount <= 0) {
      throw new OnchainApiError("buy leg returned invalid toTokenAmount", 422, "SELL_AMOUNT_INVALID");
    }

    let sellLeg: {
      quote: OnchainV6QuoteResponse;
      broadcast: OnchainV6BroadcastResponse;
    };
    try {
      sellLeg = await this.executeLeg({
        chainIndex: this.options.chainIndex,
        fromTokenAddress: baseToken.address,
        toTokenAddress: quoteToken.address,
        amount: String(sellAmount),
        dexId: plan.sellDex,
        userWalletAddress,
        leg: "sell",
      });
    } catch (error) {
      const hedge = await this.tryHedgeAfterPartialFill({
        chainIndex: this.options.chainIndex,
        fromTokenAddress: baseToken.address,
        toTokenAddress: quoteToken.address,
        amount: String(sellAmount),
        dexId: plan.buyDex,
        userWalletAddress,
      });
      const partialMessage = `buy leg ok tx=${buyLeg.broadcast.txHash}; sell leg failed on ${plan.sellDex}; hedge=${hedge}`;
      this.options.store?.insertAlert("error", "dual_leg_partial_fill", partialMessage);
      throw new OnchainApiError(`${partialMessage}; err=${String(error)}`, 409, "DUAL_LEG_PARTIAL");
    }

    const grossUsd = this.estimateGrossFromQuotes(
      quoteToken.decimals,
      buyLeg.quote,
      sellLeg.quote,
    );
    const feeUsd = this.estimateFeeFromQuotes(plan.notionalUsd, buyLeg.quote, sellLeg.quote);
    const netUsd = grossUsd - feeUsd;

    return {
      success: true,
      txHash: `${buyLeg.broadcast.txHash},${sellLeg.broadcast.txHash}`,
      status: "confirmed",
      grossUsd,
      feeUsd,
      netUsd,
      latencyMs: Date.now() - startedAt,
    };
  }

  private async executeLeg(input: {
    chainIndex: string;
    fromTokenAddress: string;
    toTokenAddress: string;
    amount: string;
    dexId: string;
    userWalletAddress: string;
    leg: "buy" | "sell" | "hedge";
  }): Promise<{ quote: OnchainV6QuoteResponse; broadcast: OnchainV6BroadcastResponse }> {
    const quote = await this.getQuoteV6({
      chainIndex: input.chainIndex,
      fromTokenAddress: input.fromTokenAddress,
      toTokenAddress: input.toTokenAddress,
      amount: input.amount,
      dexIds: input.dexId,
    });
    this.assertRouteConstraint(quote, input.dexId, input.leg);

    const swap = await this.buildSwapV6({
      chainIndex: input.chainIndex,
      fromTokenAddress: input.fromTokenAddress,
      toTokenAddress: input.toTokenAddress,
      amount: input.amount,
      dexIds: input.dexId,
      userWalletAddress: input.userWalletAddress,
      slippage: "0.5",
    });

    if (this.options.requireSimulate) {
      const simulate = await this.simulateV6({
        chainIndex: input.chainIndex,
        txData: swap.txData,
        to: swap.to,
        value: swap.value,
        userWalletAddress: input.userWalletAddress,
      });
      if (!simulate.success) {
        throw new OnchainApiError(simulate.message ?? `${input.leg} leg simulate failed`, 400, "SIMULATE_FAILED");
      }
    }

    const broadcast = await this.broadcastV6({
      chainIndex: input.chainIndex,
      txData: swap.txData,
      to: swap.to,
      value: swap.value,
      userWalletAddress: input.userWalletAddress,
    });
    await this.getHistoryV6(broadcast.txHash);
    return { quote, broadcast };
  }

  private async tryHedgeAfterPartialFill(input: {
    chainIndex: string;
    fromTokenAddress: string;
    toTokenAddress: string;
    amount: string;
    dexId: string;
    userWalletAddress: string;
  }): Promise<string> {
    try {
      const hedgeLeg = await this.executeLeg({
        ...input,
        leg: "hedge",
      });
      return `submitted:${hedgeLeg.broadcast.txHash}`;
    } catch (error) {
      return `failed:${String(error)}`;
    }
  }

  private assertRouteConstraint(quote: OnchainV6QuoteResponse, expectedDex: string, leg: "buy" | "sell" | "hedge") {
    const routers = quote.dexRouterList ?? [];
    if (routers.length === 0) {
      return;
    }
    const target = expectedDex.toLowerCase();
    const matched = routers.some((router) => (router.dexName ?? "").toLowerCase().includes(target));
    if (!matched) {
      throw new OnchainApiError(
        `${leg} leg route mismatch: expected dex ${expectedDex}`,
        422,
        "ROUTE_MISMATCH",
      );
    }
  }

  async getQuoteV6(input: OnchainV6QuoteRequest): Promise<OnchainV6QuoteResponse> {
    const query = {
      chainIndex: input.chainIndex,
      fromTokenAddress: input.fromTokenAddress,
      toTokenAddress: input.toTokenAddress,
      amount: input.amount,
      ...(input.dexIds ? { dexIds: input.dexIds } : {}),
    };

    const payload = await this.requestWithFallback<QuoteWire>({
      primary: V6_PATHS.quote,
      fallback: LEGACY_PATHS.quote,
      method: "GET",
      query,
    });

    return {
      fromTokenAmount: payload.fromTokenAmount ?? "0",
      toTokenAmount: payload.toTokenAmount ?? "0",
      estimateGasFee: payload.estimateGasFee,
      tradeFee: payload.tradeFee,
      dexRouterList: payload.dexRouterList,
      raw: payload,
    };
  }

  async buildSwapV6(input: OnchainV6SwapRequest): Promise<OnchainV6SwapResponse> {
    const query = {
      chainIndex: input.chainIndex,
      fromTokenAddress: input.fromTokenAddress,
      toTokenAddress: input.toTokenAddress,
      amount: input.amount,
      userWalletAddress: input.userWalletAddress,
      ...(input.slippage ? { slippage: input.slippage } : {}),
      ...(input.dexIds ? { dexIds: input.dexIds } : {}),
    };

    const payload = await this.requestWithFallback<Record<string, unknown>>({
      primary: V6_PATHS.swap,
      fallback: LEGACY_PATHS.swap,
      method: "GET",
      query,
    });

    const txData = this.pickString(payload, ["txData", "data", "tx_data"]);
    const to = this.pickString(payload, ["to", "toAddress", "router"]);
    const value = this.pickString(payload, ["value", "txValue", "amountOut"]);
    const gasLimit = this.pickString(payload, ["gasLimit", "gas", "estimateGas"]);
    if (!txData) {
      throw new OnchainApiError("swap payload missing txData", 422, "SWAP_PAYLOAD_INVALID");
    }

    return {
      txData,
      to,
      value,
      gasLimit,
      raw: payload,
    };
  }

  async simulateV6(input: {
    chainIndex: string;
    txData?: string;
    to?: string;
    value?: string;
    userWalletAddress: string;
  }): Promise<OnchainV6SimulateResponse> {
    const payload = await this.requestWithFallback<Record<string, unknown>>({
      primary: V6_PATHS.simulate,
      fallback: LEGACY_PATHS.simulate,
      method: "POST",
      body: {
        chainIndex: input.chainIndex,
        txData: input.txData,
        to: input.to,
        value: input.value,
        userWalletAddress: input.userWalletAddress,
      },
    });

    const successFlag = this.pickBool(payload, ["success", "simulateResult", "ok"], true);
    const message = this.pickString(payload, ["message", "msg", "errorMessage"]);
    return { success: successFlag, message, raw: payload };
  }

  async broadcastV6(input: {
    chainIndex: string;
    txData?: string;
    to?: string;
    value?: string;
    userWalletAddress: string;
  }): Promise<OnchainV6BroadcastResponse> {
    const payload = await this.requestWithFallback<Record<string, unknown>>({
      primary: V6_PATHS.broadcast,
      fallback: LEGACY_PATHS.broadcast,
      method: "POST",
      body: {
        chainIndex: input.chainIndex,
        txData: input.txData,
        to: input.to,
        value: input.value,
        userWalletAddress: input.userWalletAddress,
      },
    });

    const txHash = this.pickString(payload, ["txHash", "hash", "transactionHash"]);
    if (!txHash) {
      throw new OnchainApiError("broadcast response missing txHash", 422, "BROADCAST_PAYLOAD_INVALID");
    }

    return {
      txHash,
      status: this.pickString(payload, ["status", "txStatus"]),
      raw: payload,
    };
  }

  async getHistoryV6(txHash: string): Promise<Record<string, unknown> | null> {
    if (!txHash) {
      return null;
    }

    try {
      return await this.requestWithFallback<Record<string, unknown>>({
        primary: V6_PATHS.history,
        fallback: LEGACY_PATHS.history,
        method: "GET",
        query: { txHash },
      });
    } catch (error) {
      this.recordError(error);
      return null;
    }
  }

  private async fetchTokenProfile(symbol: string, chainIndex: string): Promise<{ address: string; decimals: number }> {
    if (!this.options.apiBase) {
      throw new OnchainApiError("token profile requires apiBase", 400, "API_BASE_REQUIRED");
    }

    const payload = await this.requestWithFallback<Record<string, unknown>>({
      primary: [this.options.tokenProfilePath],
      fallback: [],
      method: "GET",
      query: { chainIndex, tokenSymbol: symbol },
      forceDisableFallback: true,
    });

    const address = this.pickString(payload, [
      "tokenContractAddress",
      "tokenAddress",
      "address",
      "contractAddress",
      "token",
    ]);
    const decimals = toNumber(
      this.pickString(payload, ["tokenDecimal", "decimals", "decimal", "tokenDecimals"]),
      18,
    );

    if (!address) {
      throw new OnchainApiError(`token profile missing address for ${symbol}`, 422, "TOKEN_PROFILE_INVALID");
    }

    return {
      address,
      decimals,
    };
  }

  private mockTrade(plan: ExecutionPlan): TradeResult {
    const spread = (plan.sellPrice - plan.buyPrice) / plan.buyPrice;
    const grossUsd = spread * plan.notionalUsd;
    const feeUsd = Math.max(0.8, plan.notionalUsd * 0.0022);
    const netUsd = grossUsd - feeUsd;
    return {
      success: netUsd > -5,
      txHash: `0x${crypto.randomBytes(32).toString("hex")}`,
      status: netUsd > -5 ? "confirmed" : "failed",
      grossUsd,
      feeUsd,
      netUsd,
      error: netUsd > -5 ? undefined : "mock live trade not profitable",
    };
  }

  private getMockQuotes(pair: string, dexes: string[]): Quote[] {
    const epochBucket = Math.floor(Date.now() / 5000);
    const base = 3000 + seededNoise(`${pair}:${epochBucket}`) * 40;

    return dexes.map((dex, index) => {
      const noise = seededNoise(`${pair}:${dex}:${epochBucket}`);
      const spreadFactor = index === 0 ? -0.0045 : 0.0045;
      const mid = base * (1 + spreadFactor + (noise - 0.5) * 0.0025);
      const halfSpread = mid * 0.0009;
      return {
        pair,
        dex,
        bid: Number((mid - halfSpread).toFixed(6)),
        ask: Number((mid + halfSpread).toFixed(6)),
        gasUsd: this.options.gasUsdDefault,
        ts: new Date().toISOString(),
      };
    });
  }

  private estimateGrossFromQuotes(
    quoteTokenDecimals: number,
    buyQuote: OnchainV6QuoteResponse,
    sellQuote: OnchainV6QuoteResponse,
  ): number {
    const buySpendRaw = toNumber(buyQuote.fromTokenAmount);
    const sellReceiveRaw = toNumber(sellQuote.toTokenAmount);
    if (buySpendRaw > 0 && sellReceiveRaw > 0) {
      const divisor = 10 ** Math.min(Math.max(0, quoteTokenDecimals), 12);
      return (sellReceiveRaw - buySpendRaw) / divisor;
    }
    return 0;
  }

  private estimateFeeFromQuotes(
    notionalUsd: number,
    buyQuote: OnchainV6QuoteResponse,
    sellQuote: OnchainV6QuoteResponse,
  ): number {
    const buyGas = toNumber(buyQuote.estimateGasFee, this.options.gasUsdDefault);
    const sellGas = toNumber(sellQuote.estimateGasFee, this.options.gasUsdDefault);
    const buyTradeFee = toNumber(buyQuote.tradeFee, notionalUsd * 0.0006);
    const sellTradeFee = toNumber(sellQuote.tradeFee, notionalUsd * 0.0006);
    return buyGas + sellGas + buyTradeFee + sellTradeFee;
  }

  private pickPayload(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      const data = obj.data;
      if (Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === "object") {
        return data[0] as Record<string, unknown>;
      }
      if (data && typeof data === "object") {
        return data as Record<string, unknown>;
      }
      return obj;
    }
    return {};
  }

  private pickString(payload: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
      }
    }
    return undefined;
  }

  private pickBool(payload: Record<string, unknown>, keys: string[], fallback: boolean): boolean {
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === "boolean") {
        return value;
      }
      if (typeof value === "number") {
        return value !== 0;
      }
      if (typeof value === "string") {
        const lowered = value.toLowerCase();
        if (["true", "ok", "success", "1", "pass"].includes(lowered)) {
          return true;
        }
        if (["false", "fail", "failed", "0", "error"].includes(lowered)) {
          return false;
        }
      }
    }
    return fallback;
  }

  private buildAuthHeaders(url: URL, method: string, body?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    const apiKey = this.options.apiKey;

    if (!apiKey) {
      return headers;
    }

    if (this.options.authMode === "bearer") {
      headers.Authorization = `Bearer ${apiKey}`;
    } else if (this.options.authMode === "api-key") {
      headers[this.options.apiKeyHeader] = apiKey;
    } else {
      const apiSecret = this.options.apiSecret;
      if (!apiSecret) {
        return headers;
      }
      const timestamp = new Date().toISOString();
      const path = url.pathname;
      const queryString = url.search;
      const signingBody = body ?? "";
      const message = `${timestamp}${method.toUpperCase()}${path}${queryString}${signingBody}`;
      const signature = crypto.createHmac("sha256", apiSecret).update(message).digest("base64");

      headers["OK-ACCESS-KEY"] = apiKey;
      headers["OK-ACCESS-SIGN"] = signature;
      headers["OK-ACCESS-TIMESTAMP"] = timestamp;
      if (this.options.passphrase) {
        headers["OK-ACCESS-PASSPHRASE"] = this.options.passphrase;
      }
    }

    if (this.options.projectId) {
      headers["OK-ACCESS-PROJECT"] = this.options.projectId;
    }

    return headers;
  }

  private buildUrl(path: string, query?: Record<string, string>): URL {
    const url = new URL(path, this.options.apiBase);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, v);
      }
    }
    return url;
  }

  private async requestWithFallback<T>(params: {
    primary: string[];
    fallback: string[];
    method: "GET" | "POST";
    query?: Record<string, string>;
    body?: Record<string, unknown>;
    forceDisableFallback?: boolean;
  }): Promise<T> {
    const bodyText = params.body ? JSON.stringify(params.body) : undefined;

    const primaryResult = await this.tryPaths<T>(params.primary, params.method, params.query, bodyText, "v6");
    if (primaryResult.ok) {
      return primaryResult.data;
    }

    if (!primaryResult.fallbackEligible || params.forceDisableFallback || !this.options.enableCompatFallback) {
      throw primaryResult.error ?? new OnchainApiError("primary request failed");
    }

    if (params.fallback.length === 0) {
      throw primaryResult.error ?? new OnchainApiError("fallback unavailable");
    }

    const fallbackResult = await this.tryPaths<T>(
      params.fallback,
      params.method,
      params.query,
      bodyText,
      "fallback",
    );
    if (fallbackResult.ok) {
      this.diagnostics.lastFallbackAt = new Date().toISOString();
      return fallbackResult.data;
    }

    throw fallbackResult.error ?? primaryResult.error ?? new OnchainApiError("request failed with fallback");
  }

  private async tryPaths<T>(
    paths: string[],
    method: "GET" | "POST",
    query: Record<string, string> | undefined,
    bodyText: string | undefined,
    mode: "v6" | "fallback",
  ): Promise<{ ok: true; data: T } | { ok: false; fallbackEligible: boolean; error?: OnchainApiError }> {
    let fallbackEligible = true;
    let lastError: OnchainApiError | undefined;

    for (const path of paths) {
      try {
        const url = this.buildUrl(path, query);
        const headers: Record<string, string> = {
          ...(bodyText ? { "Content-Type": "application/json" } : {}),
          ...this.buildAuthHeaders(url, method, bodyText),
        };

        const response = await fetch(url, {
          method,
          headers,
          ...(bodyText ? { body: bodyText } : {}),
        });

        if (response.ok) {
          const raw = (await response.json()) as unknown;
          const payload = this.pickPayload(raw) as T;
          this.diagnostics.lastUsedPath = path;
          this.diagnostics.lastV6SuccessAt = mode === "v6" ? new Date().toISOString() : this.diagnostics.lastV6SuccessAt;
          return { ok: true, data: payload };
        }

        const responseText = await response.text();
        const parsedCode = this.extractErrorCode(responseText);
        const error = new OnchainApiError(
          `request failed ${response.status} ${path}: ${responseText.slice(0, 280)}`,
          response.status,
          parsedCode,
          path,
        );
        if (![404, 405].includes(response.status)) {
          fallbackEligible = false;
        }
        if (error.isRestricted) {
          fallbackEligible = false;
        }
        lastError = error;
      } catch (error) {
        fallbackEligible = false;
        lastError = error instanceof OnchainApiError ? error : new OnchainApiError(String(error));
      }
    }

    return { ok: false, fallbackEligible, error: lastError };
  }

  private extractErrorCode(text: string): string | undefined {
    if (!text) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(text) as { code?: string; msg?: string };
      return parsed.code ?? parsed.msg;
    } catch {
      return undefined;
    }
  }

  private recordError(error: unknown): void {
    this.diagnostics.lastError = String(error);
    this.diagnostics.lastErrorAt = new Date().toISOString();
  }

  private getProbeFailureStep(error: unknown): "token" | "quote" | "swap" | "simulate" {
    const text = String(error).toLowerCase();
    if (text.includes("token")) {
      return "token";
    }
    if (text.includes("quote")) {
      return "quote";
    }
    if (text.includes("swap")) {
      return "swap";
    }
    return "simulate";
  }
}
