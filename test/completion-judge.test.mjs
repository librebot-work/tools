import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { exportBotFiles, parseBotFiles, validateFiles } from "../src/index.js";

function files(judge, roles = ["default"]) {
  return {
    "bot.yaml": stringify({
      formatVersion: 1,
      name: "Completion",
      description: "Completion contract",
      modelRoles: roles.map((role) => ({ role, label: role })),
      ...(judge !== undefined ? { completionJudge: judge } : {}),
    }),
    "instructions.md": "Complete the requested work.",
    "README.md": "# Completion\nA test bot.",
  };
}

async function roundtrip(input) {
  const parsed = await parseBotFiles(input);
  const exported = exportBotFiles(parsed.draft);
  const restored = await parseBotFiles(exported);
  assert.deepEqual(restored.draft, parsed.draft);
  return { parsed, exported, restored };
}

describe("optional completion judge source contract", () => {
  it("does not enable automatic completion when the field is absent", async () => {
    const { parsed, exported, restored } = await roundtrip(files());
    assert.equal(Object.hasOwn(parsed.draft, "completionJudge"), false);
    assert.equal(Object.hasOwn(restored.draft, "completionJudge"), false);
    assert.doesNotMatch(exported["bot.yaml"], /completionJudge/);
  });

  it("preserves an omitted default role without materializing it", async () => {
    const instructions = "Check the requested outcome.\nKeep open if incomplete.";
    const { restored } = await roundtrip(files({ instructions }));
    assert.deepEqual(restored.draft.completionJudge, { instructions });
    assert.equal(Object.hasOwn(restored.draft.completionJudge, "modelRole"), false);
  });

  it("round-trips explicit default, built-in, and custom declared roles", async () => {
    for (const modelRole of ["default", "slow", "completion_reviewer"]) {
      const judge = { instructions: "Verify the outcome using the task tools.", modelRole };
      const { restored } = await roundtrip(files(judge, [...new Set(["default", modelRole])]));
      assert.deepEqual(restored.draft.completionJudge, judge);
    }
  });

  it("requires an explicitly selected role to exist, including built-ins", async () => {
    for (const modelRole of ["slow", "missing_custom", "judge", "has.dot", "", null, 42]) {
      const result = await validateFiles(files({ instructions: "Review.", modelRole }));
      assert.equal(result.ok, false, String(modelRole));
      assert.ok(result.errors.some((error) => error.field === "completionJudge.modelRole"));
    }
  });

  it("rejects malformed, unknown, missing, blank, and oversized judge definitions", async () => {
    for (const judge of [null, [], "review", {}, { instructions: 42 }, { instructions: " \n " }, { instructions: "x".repeat(20001) }, { instructions: "Review.", enabled: true }]) {
      const result = await validateFiles(files(judge));
      assert.equal(result.ok, false, JSON.stringify(judge));
      assert.ok(result.errors.some((error) => error.field.startsWith("completionJudge")));
    }
  });

  it("uses the existing instruction trimming and length boundary", async () => {
    const result = await parseBotFiles(files({ instructions: `  ${"x".repeat(20000)}\n` }));
    assert.equal(result.draft.completionJudge.instructions, "x".repeat(20000));
  });
});
