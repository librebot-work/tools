import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateFiles } from "../src/index.js";
import {
  BUILT_IN_MODEL_ROLES,
  CUSTOM_MODEL_ROLE_ID_RE,
  MAX_MODEL_ROLES,
  MODEL_ROLES,
  RESERVED_MODEL_ROLE_IDS,
  isBuiltInModelRole,
  isCustomModelRoleId,
  isModelRoleId,
  isReservedModelRoleId,
} from "../src/contract.js";

const base = (yaml) =>
  validateFiles({
    "bot.yaml":
      "formatVersion: 1\nname: T\ndescription: D\nmodelRoles:\n  - role: default\n    label: Main\n" +
      yaml,
    "instructions.md": "Be helpful.",
    "README.md": "# T",
  });

describe("custom model roles", () => {
  it("accepts a safe custom role id alongside default", async () => {
    const result = await base("  - role: frontend_dev_model\n    label: Frontend dev\n");
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.draft.modelRoles.map((r) => r.role),
      ["default", "frontend_dev_model"],
    );
  });

  it("keeps built-ins reserved and default mandatory", async () => {
    assert.deepEqual([...MODEL_ROLES], ["default", "smol", "slow", "plan"]);
    assert.equal(BUILT_IN_MODEL_ROLES, MODEL_ROLES);
    assert.equal(MAX_MODEL_ROLES, 8);
    assert.equal(isBuiltInModelRole("default"), true);
    assert.equal(isCustomModelRoleId("default"), false);
    assert.equal(isCustomModelRoleId("frontend_dev_model"), true);
    assert.equal(isModelRoleId("frontend_dev_model"), true);
    assert.equal(isModelRoleId("has.dot"), false);
    assert.match("frontend_dev_model", CUSTOM_MODEL_ROLE_ID_RE);
    const missing = await validateFiles({
      "bot.yaml":
        "formatVersion: 1\nname: T\ndescription: D\nmodelRoles:\n  - role: frontend_dev_model\n    label: Frontend dev\n",
      "instructions.md": "Be helpful.",
      "README.md": "# T",
    });
    assert.equal(missing.ok, false);
    assert.ok(missing.errors.some((e) => e.field === "modelRoles" && /default/.test(e.message)));
  });

  it("rejects dotted or oversized role ids", async () => {
    for (const role of ["has.dot", "x".repeat(65), "9-ok_but_long_" + "x".repeat(60)]) {
      const result = await base(`  - role: ${role}\n    label: Bad\n`);
      assert.equal(result.ok, false, role);
    }
  });

  it("rejects reserved OMP names and unsafe object keys", async () => {
    for (const reserved of RESERVED_MODEL_ROLE_IDS) assert.equal(isReservedModelRoleId(reserved), true);
    for (const role of ["task", "commit", "vision", "constructor", "prototype", "__proto__"]) {
      assert.equal(isCustomModelRoleId(role), false, role);
      assert.equal(isModelRoleId(role) && !isBuiltInModelRole(role), false, role);
      const result = await base(`  - role: ${role}\n    label: Reserved\n`);
      assert.equal(result.ok, false, role);
    }
  });

  it("rejects duplicate roles and more than the role cap", async () => {
    const dup = await base("  - role: smol\n    label: S\n  - role: smol\n    label: S2\n");
    assert.equal(dup.ok, false);
    const many = await base(
      ["smol", "slow", "plan", "a", "b", "c", "d", "e"]
        .map((r) => `  - role: ${r}\n    label: ${r}\n`)
        .join(""),
    );
    assert.equal(many.ok, false);
  });

  it("accepts a declared custom deciderRole and rejects undeclared ones", async () => {
    const ok = await base(
      "  - role: frontend_dev_model\n    label: Frontend dev\ntriggers:\n  - key: t\n    label: T\n    kind: gitrepo\n    eventTypes: [issue.opened]\n    deciderRole: frontend_dev_model\n    deciderInstructions: Decide.\n",
    );
    assert.equal(ok.ok, true);
    const bad = await base(
      "triggers:\n  - key: t\n    label: T\n    kind: gitrepo\n    eventTypes: [issue.opened]\n    deciderRole: ghost_role\n    deciderInstructions: Decide.\n",
    );
    assert.equal(bad.ok, false);
  });
});
