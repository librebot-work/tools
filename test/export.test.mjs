// Export fidelity: external references, hostile legacy names, and
// frontmatter-less skill content all survive an export->parse round-trip.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  exportBotFiles,
  parseBotFiles,
  withSkillFrontmatter,
  scaffoldBotFiles,
} from "../src/index.js";

describe("export fidelity", () => {
  it("scaffolds a valid source that round-trips its draft", async () => {
    const initial = await parseBotFiles(scaffoldBotFiles({ name: "Smoke" }));
    const roundtrip = await parseBotFiles(exportBotFiles(initial.draft));
    assert.deepEqual(roundtrip.draft, initial.draft);
  });

  it("omits platform metadata while retaining semantic identifiers", async () => {
    const files = exportBotFiles({
      name: "T",
      description: "D",
      visibility: "public",
      botPrompt: "Hi.",
      workspace: [{ id: "platform-workspace", path: "./code" }],
      triggers: [{ id: "platform-trigger", label: "Issues", kind: "github", eventTypes: ["issues.opened"], deciderInstructions: "Decide" }],
      connectors: [{ id: "connector", label: "Connector", tools: ["search"] }],
      knowledge: [{ id: "docs", name: "Docs", kind: "resource", url: "https://example.com/docs" }],
    });
    assert.doesNotMatch(files["bot.yaml"], /visibility|platform-workspace|platform-trigger/);
    const parsed = await parseBotFiles(files);
    assert.equal(parsed.draft.connectors[0].id, "connector");
    assert.equal(parsed.draft.knowledge[0].id, "docs");
    assert.equal(parsed.draft.workspace[0].path, "./code");
    assert.equal(parsed.draft.triggers[0].label, "Issues");
    assert.equal("visibility" in parsed.draft, false);
    const again = await parseBotFiles(exportBotFiles(parsed.draft));
    assert.deepEqual(again.draft, parsed.draft);
  });

  it("round-trips resource/repo knowledge through knowledgeSources", async () => {
    const draft = {
      name: "T",
      description: "D",
      visibility: "private",
      botPrompt: "Hi.",
      modelRoles: [{ role: "default", label: "Main", requirements: {} }],
      knowledge: [
        { id: "docs", name: "Docs", kind: "resource", url: "https://example.com/d" },
        {
          id: "code",
          name: "Code",
          kind: "repo",
          url: "https://github.com/o/r",
          ref: "main",
        },
      ],
      skills: [],
      connectors: [],
      triggers: [],
      workspace: [],
      githubActions: [],
    };
    const exported = exportBotFiles(draft);
    assert.ok(!Object.keys(exported).some((k) => k.startsWith("knowledge/") && k !== "knowledge/README.md"));
    const reparsed = await parseBotFiles(exported);
    assert.deepEqual(reparsed.draft.knowledge, draft.knowledge);
  });

  it("throws when file knowledge has neither content nor asset bytes", () => {
    assert.throws(
      () =>
        exportBotFiles({
          name: "T",
          botPrompt: "Hi.",
          knowledge: [{ id: "x", name: "X", kind: "file" }],
        }),
      /no content and no asset/,
    );
  });

  it("sanitizes hostile legacy names into stable id-based filenames", async () => {
    const exported = exportBotFiles({
      name: "T",
      description: "D",
      botPrompt: "Hi.",
      knowledge: [
        { id: "evil", name: "../../etc/passwd", kind: "file", content: "x" },
        { id: "evil2", name: "a/b", kind: "file", content: "y" },
      ],
    });
    const paths = Object.keys(exported).filter((k) => k.startsWith("knowledge/"));
    assert.ok(paths.every((p) => !p.includes("..") && p.split("/").length === 2));
    assert.equal(new Set(paths).size, paths.length);
    const reparsed = await parseBotFiles(exported);
    assert.equal(reparsed.draft.knowledge.length, 2);
  });

  it("injects frontmatter for legacy skill content so names survive", async () => {
    const injected = withSkillFrontmatter({
      id: "legacy",
      name: "Legacy",
      description: "Old skill.",
      content: "Just instructions.\n",
    });
    assert.match(injected, /^---\nname: "Legacy"\ndescription: "Old skill."\n---\n/);
    const exported = exportBotFiles({
      name: "T",
      description: "D",
      botPrompt: "Hi.",
      skills: [{ id: "legacy", name: "Legacy", description: "Old skill.", content: "Just instructions.\n" }],
    });
    const reparsed = await parseBotFiles(exported);
    assert.equal(reparsed.draft.skills[0].name, "Legacy");
    assert.equal(reparsed.draft.skills[0].description, "Old skill.");
  });

  it("leaves existing frontmatter untouched", () => {
    const content = '---\nname: Keep\ndescription: As-is.\n---\n\nBody.\n';
    assert.equal(
      withSkillFrontmatter({ id: "k", name: "Other", description: "X", content }),
      content,
    );
  });
});
