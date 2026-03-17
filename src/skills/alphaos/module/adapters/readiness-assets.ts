import type { NormalizedReadinessContext } from "../types";
import type { AssetsReadinessAdapterInput, AssetsReadinessAdapterPayload } from "./contracts";
import { parseBoolean, parseNumber, parseString } from "./helpers";

const ASSETS_SKILL = "binance/assets";

function readField(
  input: AssetsReadinessAdapterInput | undefined,
  key: keyof AssetsReadinessAdapterPayload,
): unknown {
  return input?.provider?.payload?.[key] ?? input?.request?.[key] ?? input?.internal?.[key];
}

function inferBalanceReady(input: {
  explicit?: boolean;
  availableNotionalUsd?: number;
  requiredNotionalUsd?: number;
  baseAssetReady?: boolean;
  quoteAssetReady?: boolean;
}): boolean | undefined {
  if (input.explicit !== undefined) {
    return input.explicit;
  }
  if (input.availableNotionalUsd !== undefined && input.requiredNotionalUsd !== undefined) {
    return input.availableNotionalUsd >= input.requiredNotionalUsd;
  }
  if (input.baseAssetReady !== undefined && input.quoteAssetReady !== undefined) {
    return input.baseAssetReady && input.quoteAssetReady;
  }
  if (input.baseAssetReady !== undefined) {
    return input.baseAssetReady;
  }
  if (input.quoteAssetReady !== undefined) {
    return input.quoteAssetReady;
  }
  return undefined;
}

export function normalizeAssetsReadinessContext(
  input: AssetsReadinessAdapterInput | undefined,
): NormalizedReadinessContext | undefined {
  if (!input) {
    return undefined;
  }

  const availableNotionalUsd = parseNumber(readField(input, "availableNotionalUsd"));
  const requiredNotionalUsd = parseNumber(readField(input, "requiredNotionalUsd"));
  const baseAssetReady = parseBoolean(readField(input, "baseAssetReady"));
  const quoteAssetReady = parseBoolean(readField(input, "quoteAssetReady"));
  const explicitBalanceReady = parseBoolean(readField(input, "balanceReady"));
  const balanceReady = inferBalanceReady({
    explicit: explicitBalanceReady,
    availableNotionalUsd,
    requiredNotionalUsd,
    baseAssetReady,
    quoteAssetReady,
  });

  if (balanceReady === undefined) {
    return undefined;
  }

  const accountScope = parseString(readField(input, "accountScope")) ?? "default";
  const sourceSkill = parseString(input.provider?.sourceSkill) ?? ASSETS_SKILL;
  const hasAssetReadiness = baseAssetReady !== undefined || quoteAssetReady !== undefined;

  return {
    accountScope,
    balanceReady,
    availableNotionalUsd,
    assetReadiness: hasAssetReadiness
      ? {
          baseAssetReady,
          quoteAssetReady,
        }
      : undefined,
    blocking: !balanceReady,
    sourceSkill,
  };
}
