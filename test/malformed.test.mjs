// Malformed source trees: structural failures carry file/field/message and
// never throw from validateFiles (parseBotFiles throws BotSourceError).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BotSourceError, parseBotFiles, validateFiles } from "../src/index.js";

const base = (yaml = "") =>
  ({
    "bot.yaml":
      "formatVersion: 1\nname: T\ndescription: D\nmodelRoles:\n  - role: default\n    label: Main\n" +
      yaml,
    "instructions.md": "Be helpful.",
  });

const fieldsOf = (result) => result.errors.map((e) => `${e.file}:${e.field}`);

describe("malformed source", () => {
  it("requires bot.yaml and instructions.md", async () => {
    const missing = await validateFiles({});
    assert.equal(missing.ok, false);
    assert.ok(missing.errors.some((e) => e.file === "bot.yaml"));
    assert.ok(missing.errors.some((e) => e.file === "instructions.md"));
  });

  it("rejects invalid YAML with the file blamed", async () => {
    const result = await validateFiles({
      ...base(),
      "bot.yaml": "formatVersion: [unclosed\n",
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.file === "bot.yaml"));
  });

  it("rejects unknown top-level keys and the removed tools field", async () => {
    const result = await validateFiles(base("frobnicate: 1\ntools: read\n"));
    assert.equal(result.ok, false);
    const fields = fieldsOf(result);
    assert.ok(fields.includes("bot.yaml:frobnicate"));
    const tools = result.errors.find((e) => e.field === "tools");
    assert.match(tools.message, /removed/);
  });

  it("rejects wrong format versions", async () => {
    const result = await validateFiles({
      ...base(),
      "bot.yaml": "formatVersion: 2\nname: T\ndescription: D\nmodelRoles:\n  - role: default\n    label: Main\n",
    });
    assert.equal(result.ok, false);
    assert.ok(fieldsOf(result).includes("bot.yaml:formatVersion"));
  });

  it("rejects non-UTF8 instructions", async () => {
    const result = await validateFiles({
      ...base(),
      "instructions.md": new Uint8Array([0xff, 0xfe, 0x00]),
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.file === "instructions.md"));
  });

  it("parseBotFiles throws BotSourceError carrying every issue", async () => {
    const error = await parseBotFiles({}).catch((e) => e);
    assert.ok(error instanceof BotSourceError);
    assert.ok(error.errors.length >= 2);
    assert.ok(Array.isArray(error.warnings));
  });

  it("accepts a minimal valid tree", async () => {
    const result = await validateFiles(base());
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.draft.name, "T");
    assert.equal(result.draft.botPrompt, "Be helpful.");
    assert.ok(!("tools" in result.draft));
  });
});
