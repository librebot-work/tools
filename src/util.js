// Shared byte/string helpers (leaf module: no imports from parse/skills-lock).

import { createHash } from "node:crypto";

/** @param {Uint8Array|string} value */
export function toBytes(value) {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  throw new Error("file map values must be strings or Uint8Arrays");
}

/** @param {Uint8Array|string} bytes */
export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Deterministic JSON with sorted object keys (lock hashing, pinning). */
export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",")}}`;
  }
  return JSON.stringify(value);
}
