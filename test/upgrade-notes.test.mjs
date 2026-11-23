// Upgrade notes: author-written release note shared with platform
// validation (contract.validateUpgradeNote) and Git history.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  exportBotFiles,
  loadSchema,
  parseBotFiles,
  validateFiles,
  validateUpgradeNote,
} from "../src/index.js";

const base = (yaml) =>
  validateFiles({
    "bot.yaml":
      "formatVersion: 1\ndescription: D\nmodelRoles:\n  - role: default\n    label: Main\n" +
      yaml,
    "instructions.md": "Be helpful.",
    "README.md": "# T",
  });

describe("validateUpgradeNote contract", () => {
  it("accepts absence, a lone summary, and both priorities", () => {
    assert.doesNotThrow(() => validateUpgradeNote(undefined, undefined));
    assert.doesNotThrow(() => validateUpgradeNote("Drops SMS support.", undefined));
    assert.doesNotThrow(() => validateUpgradeNote("Drops SMS support.", "action"));
    assert.doesNotThrow(() => validateUpgradeNote("Drops SMS support.", "notable"));
  });

  it("rejects a priority without a summary", () => {
    assert.throws(() => validateUpgradeNote(undefined, "action"), /upgradeSummary/);
    assert.throws(() => validateUpgradeNote(undefined, "notable"), /upgradeSummary/);
  });

  it("rejects empty, blank, and non-string summaries", () => {
    assert.throws(() => validateUpgradeNote("", undefined), /upgradeSummary/);
    assert.throws(() => validateUpgradeNote("   ", undefined), /upgradeSummary/);
    assert.throws(() => validateUpgradeNote(42, undefined), /upgradeSummary/);
  });

  it("counts 280 Unicode code points, not UTF-16 units", () => {
    assert.doesNotThrow(() => validateUpgradeNote("🔔".repeat(280), undefined));
    assert.throws(() => validateUpgradeNote("🔔".repeat(281), undefined), /upgradeSummary/);
    assert.doesNotThrow(() => validateUpgradeNote("a".repeat(280), "notable"));
    assert.throws(() => validateUpgradeNote("a".repeat(281), "notable"), /upgradeSummary/);
  });

  it("rejects multi-line and control content", () => {
    for (const summary of ["One\nTwo", "One\rTwo", "Has\ttab", "Has" + String.fromCharCode(0) + "control", "One" + String.fromCodePoint(0x2028) + "Two", "One" + String.fromCodePoint(0x2029) + "Two", "One" + String.fromCharCode(0x7f) + "Two"]) {
      assert.throws(() => validateUpgradeNote(summary, undefined), /upgradeSummary/, JSON.stringify(summary));
    }
  });

  it("rejects unknown priorities", () => {
    assert.throws(() => validateUpgradeNote("Drops SMS support.", "urgent"), /upgradePriority/);
    assert.throws(() => validateUpgradeNote("Drops SMS support.", ""), /upgradePriority/);
  });
});

describe("upgrade notes in source", () => {
  it("parses a trimmed summary and priority into the draft", async () => {
    const result = await base('upgradeSummary: "  Drops SMS support.  "\nupgradePriority: notable\n');
    assert.equal(result.ok, true);
    assert.equal(result.draft.upgradeSummary, "Drops SMS support.");
    assert.equal(result.draft.upgradePriority, "notable");
  });

  it("omits both fields when absent", async () => {
    const result = await base("");
    assert.equal(result.ok, true);
    assert.equal("upgradeSummary" in result.draft, false);
    assert.equal("upgradePriority" in result.draft, false);
  });

  it("blames priority without a summary on upgradePriority", async () => {
    const result = await base("upgradePriority: action\n");
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.field === "upgradePriority" && /upgradeSummary/.test(e.message)));
  });

  it("blames multi-line and over-long summaries on upgradeSummary", async () => {
    const multiline = await base("upgradeSummary: |\n  One\n  Two\n");
    assert.equal(multiline.ok, false);
    assert.ok(multiline.errors.some((e) => e.field === "upgradeSummary"));
    const emoji = "🔔".repeat(281);
    const long = await base(`upgradeSummary: "${emoji}"\n`);
    assert.equal(long.ok, false);
    assert.ok(long.errors.some((e) => e.field === "upgradeSummary"));
  });

  it("round-trips the note through export and parse", async () => {
    const parsed = await parseBotFiles({
      ...{
        "bot.yaml":
          "formatVersion: 1\ndescription: D\nupgradeSummary: Drops SMS support.\nupgradePriority: action\nmodelRoles:\n  - role: default\n    label: Main\n",
        "instructions.md": "Be helpful.",
        "README.md": "# T",
      },
    });
    assert.equal(parsed.draft.upgradeSummary, "Drops SMS support.");
    const roundtrip = await parseBotFiles(exportBotFiles(parsed.draft));
    assert.equal(roundtrip.draft.upgradeSummary, "Drops SMS support.");
    assert.equal(roundtrip.draft.upgradePriority, "action");
  });

  it("never exports server-resolved source fields", async () => {
    const parsed = await parseBotFiles({
      "bot.yaml":
        "formatVersion: 1\ndescription: D\nupgradeSummary: Drops SMS support.\nmodelRoles:\n  - role: default\n    label: Main\n",
      "instructions.md": "Be helpful.",
      "README.md": "# T",
    });
    const withServer = { ...parsed.draft, sourceCommit: "abc123", sourceTag: "v2", visibility: "private" };
    const files = exportBotFiles(withServer);
    assert.doesNotMatch(files["bot.yaml"], /sourceCommit|sourceTag|visibility/);
    assert.match(files["bot.yaml"], /upgradeSummary/);
  });

  it("throws on export with an invalid note", () => {
    assert.throws(() => exportBotFiles({
      description: "D",
      botPrompt: "Be helpful.",
      readme: "# T",
      modelRoles: [{ role: "default", label: "Main" }],
      knowledge: [],
      skills: [],
      connectors: [],
      triggers: [],
      workspace: [],
      actions: [],
      upgradePriority: "action",
    }), /upgradeSummary/);
  });

  it("ships the upgrade properties in the v1 schema", async () => {
    const schema = await loadSchema("v1");
    assert.equal(schema.properties.upgradeSummary.type, "string");
    assert.deepEqual(schema.properties.upgradePriority.enum, ["action", "notable"]);
  });
});
