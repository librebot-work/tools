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
    "README.md": "# T",
  });

const messages = (result) => result.errors.map((e) => e.message);

describe("semantic cross-references", () => {
  it("applies the draft quota to UTF-8 bytes rather than characters", async () => {
    const files = {
      "bot.yaml": "formatVersion: 1\nname: T\ndescription: D\nmodelRoles:\n  - role: default\n    label: Main\n",
      "instructions.md": "Be helpful.",
      "README.md": "# T",
    };
    for (let i = 0; i < 4; i++) files[`knowledge/${i}.txt`] = "界".repeat(70_000);
    const result = await validateFiles(files);
    assert.equal(result.ok, false);
    assert.ok(messages(result).some((message) => message.includes("750")));
  });

  it("rejects triggers whose deciderRole is not declared", async () => {
    const result = await base(
      "triggers:\n  - key: triage\n    label: T\n    kind: gitrepo\n    eventTypes: [issue.opened]\n    deciderRole: slow\n    deciderInstructions: decide\n",
    );
    assert.equal(result.ok, false);
    assert.ok(messages(result).some((m) => m.includes("declared model roles")));
  });

  it("accepts API-only actions without a workspace mount", async () => {
    const result = await base("actions: [{key: repo, kind: gitrepo, capabilities: [read_issue]}]\n");
    assert.equal(result.ok, true);
    assert.equal(result.draft.actions[0].key, "repo");
  });

  it("accepts every portable repository capability", async () => {
    const capabilities = ["read_issue", "push_branch", "propose_change", "comment_issue", "search_issues", "read_change_request", "read_repository", "update_issue_labels", "react_issue", "update_issue_body", "update_issue_title", "publish_attachments", "merge_change_request"];
    const result = await base(`workspace: [{key: source, path: ./code}]\nactions: [{key: repo, kind: gitrepo, capabilities: ${JSON.stringify(capabilities)}}]\n`);
    assert.equal(result.ok, true);
    assert.deepEqual(result.draft.actions[0].capabilities, capabilities);
  });

  it("parses and validates a bot authored with merge_change_request and change_request.checks_updated", async () => {
    const result = await base("workspace: [{key: source, path: ./code}]\nactions: [{key: repo, kind: gitrepo, capabilities: [read_change_request, merge_change_request]}]\ntriggers: [{key: checks, label: Checks, kind: gitrepo, eventTypes: [change_request.checks_updated], deciderInstructions: Decide.}]\n");
    assert.equal(result.ok, true);
    assert.deepEqual(result.draft.actions[0].capabilities, ["read_change_request", "merge_change_request"]);
    assert.deepEqual(result.draft.triggers[0].eventTypes, ["change_request.checks_updated"]);
    assert.equal((await base("actions: [{key: repo, kind: gitrepo, capabilities: [merge_pull_request]}]\n")).ok, false);
  });

  it("rejects malformed action groups and native provider capabilities", async () => {
    for (const value of [
      "null", "read_issue", "[read_issue]",
      "[{key: repo, kind: github, capabilities: [read_issue]}]",
      "[{key: repo, kind: gitrepo, capabilities: [pull_request]}]",
      "[{key: repo, kind: gitrepo, capabilities: [read_merge_request]}]",
      "[{key: repo, kind: gitrepo, capabilities: []}]",
      "[{key: repo, kind: gitrepo, capabilities: [read_issue, read_issue]}]",
      JSON.stringify(Array.from({ length: 21 }, (_, i) => ({ key: `repo${i}`, kind: "gitrepo", capabilities: ["read_issue"] }))),
    ]) {
      assert.equal((await base(`actions: ${value}\n`)).ok, false, value);
    }
  });

  it("keeps independent action keys even when labels match", async () => {
    const result = await base("actions: [{key: primary, label: Repository, kind: gitrepo, capabilities: [read_issue]}, {key: secondary, label: Repository, kind: gitrepo, capabilities: [propose_change]}]\n");
    assert.equal(result.ok, true);
    assert.deepEqual(result.draft.actions.map((action) => action.key), ["primary", "secondary"]);
    assert.equal((await base("actions: [{key: same, kind: gitrepo, capabilities: [read_issue]}, {key: same, kind: gitrepo, capabilities: [propose_change]}]\n")).ok, false);
  });

  it("rejects overlapping and duplicate mounts", async () => {
    const overlap = await base("workspace:\n  - {key: source, path: ./code}\n  - {key: nested, path: ./code/deep}\n");
    assert.equal(overlap.ok, false);
    assert.ok(messages(overlap).some((m) => m.includes("overlap")));
    const exclusive = await base(
      "workspace:\n  - {key: root, path: ./}\n  - {key: source, path: ./code}\n",
    );
    assert.equal(exclusive.ok, false);
  });

  it("rejects platform-owned metadata in source", async () => {
    for (const yaml of [
      "visibility: private\n",
      "workspace:\n  - {id: legacy, key: source, path: ./code}\n",
      "triggers:\n  - {id: legacy, key: triage, label: T, kind: gitrepo, eventTypes: [issue.opened], deciderInstructions: decide}\n",
      "connectors:\n  - {id: legacy, label: C, tools: [search]}\n",
    ]) {
      const result = await base(yaml);
      assert.equal(result.ok, false);
      assert.ok(messages(result).some((message) => message.includes("unsupported field")));
    }
  });

  it("preserves explicit keys across labels and paths and rejects duplicate keys", async () => {
    const yaml = "workspace:\n  - {key: source, label: Source, path: ./code}\ntriggers:\n  - {key: triage, label: T, kind: gitrepo, eventTypes: [issue.opened], deciderInstructions: decide}\nconnectors:\n  - {label: C, tools: [search]}\n";
    const first = await base(yaml);
    const second = await base(yaml.replace("label: Source", "label: Renamed").replace("./code", "./renamed").replace("label: T,", "label: Renamed,"));
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.draft.workspace[0].key, first.draft.workspace[0].key);
    assert.equal(second.draft.triggers[0].key, first.draft.triggers[0].key);
    assert.deepEqual(first.draft.connectors, second.draft.connectors);
    const duplicate = await base("triggers:\n  - {key: same, label: T, kind: gitrepo, eventTypes: [issue.opened], deciderInstructions: decide}\n  - {key: same, label: Other, kind: gitrepo, eventTypes: [issue.closed], deciderInstructions: decide}\n");
    assert.equal(duplicate.ok, false);
    const sameLabel = await base("triggers:\n  - {key: first, label: T, kind: gitrepo, eventTypes: [issue.opened], deciderInstructions: decide}\n  - {key: second, label: T, kind: gitrepo, eventTypes: [issue.closed], deciderInstructions: decide}\n");
    assert.equal(sameLabel.ok, true);
    const duplicateConnectors = await base("connectors:\n  - {label: C, tools: [search]}\n  - {label: ' C ', tools: [other]}\n");
    assert.equal(duplicateConnectors.ok, false);
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
      "README.md": "# T",
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
      "README.md": "# T",
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
      "README.md": "# T",
      "skills/empty/SKILL.md": "   \n",
    });
    assert.equal(result.ok, false);
    assert.ok(messages(result).some((m) => m.includes("must not be empty")));
  });
});
