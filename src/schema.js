// Versioned bot.yaml JSON Schema loading.

import { readFile } from "node:fs/promises";

export const SCHEMA_VERSIONS = ["v1"];

/** Load the versioned bot.yaml JSON Schema (parsed object). */
export async function loadSchema(version = "v1") {
  if (version !== "v1") {
    throw new Error(`unknown schema version ${version} (available: v1)`);
  }
  const url = new URL("../schema/v1/bot-yaml-schema.json", import.meta.url);
  return JSON.parse(await readFile(url, "utf8"));
}
