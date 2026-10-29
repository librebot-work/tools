// Semantic cross-file rules: references must resolve, mounts must compose,
// declarations must stay within platform limits.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateFiles } from "../src/index.js";

const base = (yaml) =>
  validateFiles({
    "bot.yaml":
      "formatVersion: 1\nname: T\ndescription: D\nmodelRoles:\n  - role: default\n    label: Main\n" +
      yaml,
    "instructions.md": "Be helpful.",
  });

const messages = (result) => result.errors.map((e) => e.message);

describe("semantic cross-references", () => {
  it("applies the draft quota to UTF-8 bytes rather than characters", async () => {
    const files = {
      "bot.yaml": "formatVersion: 1\nname: T\ndescription: D\nmodelRoles:\n  - role: default\n    label: Main\n",
      "instructions.md": "Be helpful.",
    };
    for (let i = 0; i < 4; i++) files[`knowledge/${i}.txt`] = "界".repeat(70_000);
    const result = await validateFiles(files);
    assert.equal(result.ok, false);
    assert.ok(messages(result).some((message) => message.includes("750")));
  });

  it("rejects triggers whose deciderRole is not declared", async () => {
    const result = await base(
      "triggers:\n  - label: T\n    kind: github\n    eventTypes: [issues.opened]\n    deciderRole: slow\n    deciderInstructions: decide\n",
    );
    assert.equal(result.ok, false);
    assert.ok(messages(result).some((m) => m.includes("declared model roles")));
  });

  it("rejects githubActions without a workspace mount", async () => {
    const result = await base("githubActions: [read_issue]\n");
    assert.equal(result.ok, false);
    assert.ok(messages(result).some((m) => m.includes("workspace mount")));
  });

  it("rejects overlapping and duplicate mounts", async () => {
    const overlap = await base("workspace:\n  - {path: ./code}\n  - {path: ./code/deep}\n");
    assert.equal(overlap.ok, false);
    assert.ok(messages(overlap).some((m) => m.includes("overlap")));
    const exclusive = await base(
      "workspace:\n  - {path: ./}\n  - {path: ./code}\n",
    );
    assert.equal(exclusive.ok, false);
  });

  it("rejects platform-owned metadata in source", async () => {
    for (const yaml of [
      "visibility: private\n",
      "workspace:\n  - {id: legacy, path: ./code}\n",
      "triggers:\n  - {id: legacy, label: T, kind: github, eventTypes: [issues.opened], deciderInstructions: decide}\n",
      "connectors:\n  - {id: legacy, label: C, tools: [search]}\n",
    ]) {
      const result = await base(yaml);
      assert.equal(result.ok, false);
      assert.ok(messages(result).some((message) => message.includes("unsupported field")));
    }
  });

  it("derives stable declaration identities and rejects duplicate trigger labels", async () => {
    const yaml = "workspace:\n  - {path: ./code}\ntriggers:\n  - {label: T, kind: github, eventTypes: [issues.opened], deciderInstructions: decide}\nconnectors:\n  - {label: C, tools: [search]}\n";
    const first = await base(yaml);
    const second = await base(yaml);
    assert.equal(first.ok, true);
    assert.deepEqual(first.draft.workspace, second.draft.workspace);
    assert.deepEqual(first.draft.triggers, second.draft.triggers);
    assert.deepEqual(first.draft.connectors, second.draft.connectors);
    const duplicate = await base("triggers:\n  - {label: T, kind: github, eventTypes: [issues.opened], deciderInstructions: decide}\n  - {label: T, kind: github, eventTypes: [issues.closed], deciderInstructions: decide}\n");
    assert.equal(duplicate.ok, false);
    assert.ok(messages(duplicate).some((message) => message.includes("duplicate trigger label")));
    const duplicateConnectors = await base("connectors:\n  - {label: C, tools: [search]}\n  - {label: ' C ', tools: [other]}\n");
    assert.equal(duplicateConnectors.ok, false);
    assert.ok(messages(duplicateConnectors).some((message) => message.includes("duplicate connector label")));
  });

  it("rejects connector resources outside declared tools", async () => {
    const result = await base(
      "connectors:\n  - label: C\n    tools: [search]\n    resources:\n      - key: r\n        label: R\n        tools: [delete]\n",
    );
    assert.equal(result.ok, false);
    assert.ok(messages(result).some((m) => m.includes("declared connector tool")));
  });

  it("rejects local-execution MCP declarations", async () => {
    const result = await base(
      "connectors:\n  - label: C\n    tools: [search]\n    command: /bin/evil\n",
    );
    assert.equal(result.ok, false);
    assert.ok(
      messages(result).some(
        (m) => m.includes("unsupported field") || m.includes("local-execution"),
      ),
    );
  });

  it("accepts a remote MCP endpoint and preserves model requirements", async () => {
    const result = await validateFiles({
      "bot.yaml":
        "formatVersion: 1\nname: T\ndescription: D\nmodelRoles:\n  - role: default\n    label: Main\n    requirements: { vision: true, minContextWindow: 128000 }\nconnectors:\n  - label: GitHub\n    tools: [search]\n    endpoint: https://mcp.example.com/rpc\n",
      "instructions.md": "Be helpful.",
    });
    assert.equal(result.ok, true);
    assert.equal(result.draft.connectors[0].endpoint, "https://mcp.example.com/rpc");
    assert.equal(result.draft.modelRoles[0].requirements.vision, true);
    assert.equal(result.draft.modelRoles[0].requirements.minContextWindow, 128000);
    assert.equal(result.draft.modelRoles[0].requirements.tools, true);
  });

  it("parses structured knowledgeSources and rejects id collisions", async () => {
    const good = await base(
      "knowledgeSources:\n  - id: docs\n    name: Docs\n    kind: resource\n    url: https://example.com/docs\n  - id: repo\n    name: Repo\n    kind: repo\n    url: https://github.com/o/r\n    ref: main\n",
    );
    assert.equal(good.ok, true);
    assert.equal(good.draft.knowledge.length, 2);
    assert.equal(good.draft.knowledge[1].ref, "main");

    const collision = await validateFiles({
      "bot.yaml":
        "formatVersion: 1\nname: T\ndescription: D\nmodelRoles:\n  - role: default\n    label: Main\nknowledgeSources:\n  - id: guide__intro.md\n    name: Guide\n    kind: resource\n    url: https://example.com/g\n",
      "instructions.md": "Be helpful.",
      "knowledge/guide/intro.md": "hello",
    });
    assert.equal(collision.ok, false);
    assert.ok(messages(collision).some((m) => m.includes("duplicate knowledge id")));
  });

  it("rejects empty SKILL.md like platform content validation", async () => {
    const result = await validateFiles({
      "bot.yaml":
        "formatVersion: 1\nname: T\ndescription: D\nmodelRoles:\n  - role: default\n    label: Main\n",
      "instructions.md": "Be helpful.",
      "skills/empty/SKILL.md": "   \n",
    });
    assert.equal(result.ok, false);
    assert.ok(messages(result).some((m) => m.includes("must not be empty")));
  });
});
