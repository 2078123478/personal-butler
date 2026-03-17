import type { NormalizedEnrichmentContext } from "../types";
import type { TokenInfoAdapterInput, TokenInfoAdapterPayload } from "./contracts";
import { parseNumber, parseString } from "./helpers";

const TOKEN_INFO_SKILL = "binance-web3/query-token-info";

function readField(
  input: TokenInfoAdapterInput | undefined,
  key: keyof TokenInfoAdapterPayload,
): unknown {
  return input?.provider?.payload?.[key] ?? input?.request?.[key] ?? input?.internal?.[key];
}

export function normalizeTokenInfoEnrichment(
  input: TokenInfoAdapterInput | undefined,
): NormalizedEnrichmentContext | undefined {
  if (!input) {
    return undefined;
  }

  const token = {
    name: parseString(readField(input, "name")),
    symbol: parseString(readField(input, "symbol")),
    chainId: parseNumber(readField(input, "chainId")),
    contractAddress: parseString(readField(input, "contractAddress")),
  };

  if (!token.name && !token.symbol && token.chainId === undefined && !token.contractAddress) {
    return undefined;
  }

  const sourceSkill = parseString(input.provider?.sourceSkill) ?? TOKEN_INFO_SKILL;
  return {
    token,
    sourceSkills: [sourceSkill],
  };
}
