import { randomUUID } from "node:crypto";
import type { EntityId, Timestamp } from "./types.ts";

/** Generate a globally unique runtime entity id. */
export function newId(): EntityId {
  return randomUUID();
}

/** Current wall-clock time in epoch milliseconds. */
export function now(): Timestamp {
  return Date.now();
}
