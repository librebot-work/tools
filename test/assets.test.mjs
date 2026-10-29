// Binary knowledge assets and skill supporting files: bytes travel beside
// the draft with hashes, never silently dropped or double-prefixed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  exportBotFiles,
  parseBotFiles,
  sanitizeAssetRel,
  sha256Hex,
  validateFiles,
} from "../src/index.js";

const base = (extra = {}) => ({
  "bot.yaml":
    "formatVersion: 1\nname: T\ndescription: D\nmodelRoles:\n  - role: default\n    label: Main\n",
  "instructions.md": "Be helpful.",
  ...extra,
});

describe("binary assets", () => {
  it("emits binary knowledge as hashed assets without inline content", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const result = await validateFiles(base({ "knowledge/image.png": bytes }));
    assert.equal(result.ok, true);
    assert.equal(result.draft.knowledge.length, 1);
    assert.equal(result.draft.knowledge[0].content, undefined);
    assert.equal(result.assets.length, 1);
    const [asset] = result.assets;
    assert.equal(asset.path, "image.png");
    assert.equal(asset.mime, "image/png");
    assert.equal(asset.sha256, sha256Hex(bytes));
    assert.deepEqual(asset.bytes, bytes);
  });

  it("inlines UTF-8 knowledge and preserves skill supporting files", async () => {
    const result = await validateFiles(
      base({
        "knowledge/guide.md": "# Guide\n",
        "skills/review/SKILL.md": "---\nname: Review\ndescription: Reviews code.\n---\n\nDo reviews.\n",
        "skills/review/reference.md": "reference material",
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.draft.knowledge[0].content, "# Guide\n");
    assert.equal(result.draft.skills[0].name, "Review");
    assert.equal(result.draft.skills[0].description, "Reviews code.");
    assert.equal(result.skillFiles.length, 1);
    assert.equal(result.skillFiles[0].path, "reference.md");
    assert.equal(result.skillFiles[0].skillId, "review");
  });

  it("round-trips export back through the parser byte-identically", async () => {
    const parsed = await parseBotFiles(
      base({
        "knowledge/guide.md": "# Guide\n",
        "knowledge/image.png": new Uint8Array([0x89, 0x50, 0x00]),
        "skills/review/SKILL.md": "# Review\n\nDo reviews.\n",
        "skills/review/reference.md": "reference",
      }),
    );
    const exported = exportBotFiles(parsed.draft, {
      assets: parsed.assets,
      skillFiles: parsed.skillFiles,
    });
    assert.ok(!Object.keys(exported).some((k) => k.includes("knowledge/knowledge/")));
    const reparsed = await parseBotFiles(exported);
    assert.equal(reparsed.draft.knowledge.length, 2);
    assert.equal(reparsed.draft.skills.length, 1);
    assert.equal(reparsed.draft.skills[0].name, "Review");
    assert.equal(reparsed.skillFiles.length, 1);
    assert.equal(reparsed.assets.length, 1);
    assert.equal(reparsed.assets[0].sha256, parsed.assets[0].sha256);
  });

  it("strips a redundant knowledge/ asset prefix instead of doubling it", () => {
    assert.equal(sanitizeAssetRel("knowledge/img/a.png"), "img/a.png");
    assert.equal(sanitizeAssetRel("img/a.png"), "img/a.png");
    assert.equal(sanitizeAssetRel("../../etc/passwd"), "file_../file_../etc/passwd");
  });
});
