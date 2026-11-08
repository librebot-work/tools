import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBotFiles, validateFiles, exportBotFiles, scaffoldBotFiles, scaffoldBot, validateSource } from "../src/index.js";

const files = (extra = {}) => ({
  "bot.yaml": "formatVersion: 1\nname: T\ndescription: D\nmodelRoles:\n  - role: default\n    label: Main\n",
  "instructions.md": "Be helpful.",
  "README.md": "# T",
  ...extra,
});

describe("root README documentation", () => {
  it("parses trimmed UTF-8 documentation separately from prompt and knowledge", async () => {
    const parsed = await parseBotFiles(files({
      "README.md": new TextEncoder().encode(" \n# Welcome 界\n\nFor users.\n "),
      "knowledge/README.md": "Knowledge index only.",
      "knowledge/guide.md": "Reference material.",
    }));
    assert.equal(parsed.draft.readme, "# Welcome 界\n\nFor users.");
    assert.equal(parsed.draft.botPrompt, "Be helpful.");
    assert.deepEqual(parsed.draft.knowledge.map((entry) => entry.content), ["Reference material."]);
    assert.deepEqual(parsed.source.knowledgeFiles, ["guide.md"]);
    assert.deepEqual(parsed.assets, []);
  });

  it("rejects a missing root README even when the knowledge index exists", async () => {
    const source = files({ "knowledge/README.md": "# Knowledge" });
    delete source["README.md"];
    const result = await validateFiles(source);
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, [{ file: "README.md", field: "", message: "is required" }]);
    await assert.rejects(parseBotFiles(source), (error) => {
      assert.deepEqual(error.errors, result.errors);
      return true;
    });
  });

  for (const readme of [undefined, null, 42, "", " \n\t "]) {
    it(`rejects export with invalid readme ${JSON.stringify(readme)}`, async () => {
      const { draft } = await parseBotFiles(files());
      if (readme === undefined) delete draft.readme;
      else draft.readme = readme;
      assert.throws(() => exportBotFiles(draft), /requires a non-empty draft readme/);
    });
  }

  it("trims exported documentation and rejects oversized documentation", async () => {
    const { draft } = await parseBotFiles(files());
    assert.equal(exportBotFiles({ ...draft, readme: " \n# Guide\n " })["README.md"], "# Guide");
    assert.throws(
      () => exportBotFiles({ ...draft, readme: "x".repeat(100001) }),
      /readme is too long/,
    );
  });

  it("round-trips root README without adding a bot.yaml field", async () => {
    const parsed = await parseBotFiles(files({ "README.md": "# T\n\nUser guide." }));
    const exported = exportBotFiles(parsed.draft);
    assert.equal(exported["README.md"], parsed.draft.readme);
    assert.doesNotMatch(exported["bot.yaml"], /readme/i);
    const again = await parseBotFiles(exported);
    assert.deepEqual(again.draft, parsed.draft);
  });

  for (const [name, value, message] of [
    ["invalid UTF-8", new Uint8Array([0xc3, 0x28]), "must be UTF-8 text"],
    ["empty text", "", "must not be empty"],
    ["whitespace-only text", " \n\t\r ", "must not be empty"],
    ["too-long text", "x".repeat(100001), "is too long (max 100000 chars)"],
  ]) {
    it(`rejects ${name} with a root README diagnostic`, async () => {
      const source = files({ "README.md": value });
      const result = await validateFiles(source);
      assert.equal(result.ok, false);
      assert.deepEqual(result.errors, [{ file: "README.md", field: "", message }]);
      await assert.rejects(parseBotFiles(source), (error) => {
        assert.deepEqual(error.errors, result.errors);
        return true;
      });
    });
  }

  it("accepts the character limit after trimming, rather than a byte limit", async () => {
    const readme = "界".repeat(100000);
    const parsed = await parseBotFiles(files({ "README.md": ` \n${readme}\n ` }));
    assert.equal(parsed.draft.readme, readme);
  });

  it("includes useful root documentation in file-map and on-disk scaffolds", async () => {
    const source = scaffoldBotFiles({ name: "Helper" });
    assert.match(source["README.md"], /^# Helper\n/);
    for (const path of ["bot.yaml", "instructions.md", "knowledge/", "skills/"]) {
      assert.ok(source["README.md"].includes(path));
    }
    assert.notEqual(source["README.md"], source["knowledge/README.md"]);
    const parsed = await parseBotFiles(source);
    assert.equal(parsed.draft.readme, source["README.md"].trim());
    const dir = await mkdtemp(join(tmpdir(), "librebot-readme-"));
    try {
      const written = await scaffoldBot(dir, { name: "Helper" });
      assert.ok(written.includes("README.md"));
      const result = await validateSource(dir);
      assert.equal(result.ok, true, JSON.stringify(result.errors));
      assert.equal(result.draft.readme, parsed.draft.readme);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
