import type { NormalizedMarketContext } from "../types";
import type { SpotMarketAdapterInput, SpotMarketAdapterPayload } from "./contracts";
import { parseBoolean, parseNumber, parseString } from "./helpers";

const SPOT_SKILL = "binance/spot";
const SPOT_VENUE = "binance-spot";

function readField(
  input: SpotMarketAdapterInput | undefined,
  key: keyof SpotMarketAdapterPayload,
): unknown {
  return input?.provider?.payload?.[key] ?? input?.request?.[key] ?? input?.internal?.[key];
}

export function normalizeSpotMarketContext(
  input: SpotMarketAdapterInput | undefined,
): NormalizedMarketContext | undefined {
  if (!input) {
    return undefined;
  }

  const pair = parseString(readField(input, "pair"));
  if (!pair) {
    return undefined;
  }

  const sourceSkill = parseString(input.provider?.sourceSkill) ?? SPOT_SKILL;
  const venue = parseString(readField(input, "venue")) ?? SPOT_VENUE;
  const bid = parseNumber(readField(input, "bid"));
  const ask = parseNumber(readField(input, "ask"));
  const gasUsd = parseNumber(readField(input, "gasUsd"));
  const quoteTs = parseString(readField(input, "quoteTs"));
  const chainId = parseNumber(readField(input, "chainId"));
  const marketType = parseString(readField(input, "marketType")) ?? "spot";
  const alphaContext = parseBoolean(readField(input, "alphaContext")) ?? false;

  return {
    pair,
    venue,
    bid,
    ask,
    quoteTs,
    gasUsd,
    marketContext: {
      chainId,
      marketType,
      alphaContext,
    },
    sourceSkill,
  };
}
