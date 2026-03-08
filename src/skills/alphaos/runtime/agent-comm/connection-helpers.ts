import type { StateStore } from "../state-store";
import {
  isConnectionCommandType,
  type AgentCommand,
  type AgentConnectionEvent,
  type AgentConnectionEventType,
} from "./types";

export function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeOptionalStringList(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }

  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

export function readConnectionEventMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function readConnectionEventMetadataStringArray(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined {
  const value = metadata?.[key];
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = [
    ...new Set(
      value.filter((item): item is string => typeof item === "string" && item.trim().length > 0),
    ),
  ];
  return normalized.length > 0 ? normalized : undefined;
}

export function getPendingInviteEvent(
  store: StateStore,
  contactId: string,
  direction: "inbound" | "outbound",
): AgentConnectionEvent | undefined {
  return store.listAgentConnectionEvents(1, {
    contactId,
    direction,
    eventType: "connection_invite",
    eventStatus: "pending",
  })[0];
}

export function getConnectionEventType(
  command: AgentCommand,
): AgentConnectionEventType | undefined {
  if (!isConnectionCommandType(command.type)) {
    return undefined;
  }
  return command.type;
}
