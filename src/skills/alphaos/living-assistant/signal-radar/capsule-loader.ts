import fs from "node:fs";
import path from "node:path";
import type { NormalizedSignal } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNormalizedSignal(value: unknown): value is NormalizedSignal {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.signalId === "string" &&
    typeof value.source === "string" &&
    typeof value.type === "string" &&
    typeof value.title === "string" &&
    typeof value.urgency === "string" &&
    typeof value.relevanceHint === "string" &&
    typeof value.detectedAt === "string"
  );
}

function assertSignals(value: unknown, filePath: string): NormalizedSignal[] {
  const items = Array.isArray(value) ? value : [value];
  if (items.length === 0) {
    return [];
  }

  const invalidIndex = items.findIndex((item) => !isNormalizedSignal(item));
  if (invalidIndex !== -1) {
    throw new Error(`Invalid normalized signal at index ${invalidIndex} in ${filePath}`);
  }

  return items;
}

export function loadSignalCapsule(filePath: string): NormalizedSignal[] {
  const resolvedPath = path.resolve(filePath);
  const raw = fs.readFileSync(resolvedPath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  return assertSignals(parsed, resolvedPath);
}

export function loadSignalCapsuleFixture(
  fileName: string,
  fixtureDir = path.resolve(process.cwd(), "fixtures", "signal-capsules"),
): NormalizedSignal[] {
  return loadSignalCapsule(path.join(fixtureDir, fileName));
}
