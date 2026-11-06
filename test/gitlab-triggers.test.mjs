import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { parseBotFiles, scaffoldBotFiles, exportBotFiles } from "../src/index.js";
import { GITLAB_TRIGGER_EVENT_TYPES } from "../src/validate.js";

const trigger = (overrides = {}) => ({ label: "Project events", kind: "gitlab", eventTypes: ["merge_request.open"], repository: { mode: "pinned", fullName: "group/subgroup/project" }, deciderInstructions: "Decide whether to act", ...overrides });
const source = (triggers) => ({ ...scaffoldBotFiles({ name: "Triggers" }), "bot.yaml": `formatVersion: 1\nname: Triggers\ndescription: D\nmodelRoles: [{role: default, label: Main}]\ntriggers: ${JSON.stringify(triggers)}\n` });

describe("GitLab trigger authoring", () => {
  it("round-trips every native event, nested project paths and stable declaration IDs", async () => {
    const initial = await parseBotFiles(source([trigger({ eventTypes: GITLAB_TRIGGER_EVENT_TYPES })]));
    assert.equal(initial.draft.triggers[0].kind, "gitlab");
    const roundtrip = await parseBotFiles(exportBotFiles(initial.draft));
    assert.deepEqual(roundtrip.draft.triggers, initial.draft.triggers);
    const github = await parseBotFiles(source([trigger({ kind: "github", eventTypes: ["issues.opened"], repository: { mode: "pinned", fullName: "owner/repo" } })]));
    assert.equal(initial.draft.triggers[0].id, github.draft.triggers[0].id);
    assert.equal(github.draft.triggers[0].kind, "github");
    const anyProject = await parseBotFiles(source([trigger({ repository: { mode: "any" } })]));
    assert.deepEqual(anyProject.draft.triggers[0].repository, { mode: "any" });
    const maxSegment = await parseBotFiles(source([trigger({ repository: { mode: "pinned", fullName: `${"a".repeat(100)}/project` } })]));
    assert.equal(maxSegment.draft.triggers[0].repository.fullName.length, 108);
  });

  it("rejects provider mismatches, unknown events, duplicates and invalid project paths", async () => {
    const invalid = [
      trigger({ kind: "unknown" }), trigger({ eventTypes: ["issues.opened"] }),
      trigger({ eventTypes: ["pull_request.opened"] }), trigger({ eventTypes: ["unknown"] }),
      trigger({ eventTypes: ["push", "push"] }),
      ...["project", "group//project", "/group/project", "group/project/", "group/../project", "https://gitlab.example/g/p"].map((fullName) => trigger({ repository: { mode: "pinned", fullName } })),
      trigger({ kind: "github", eventTypes: ["issues.opened"] }),
      trigger({ repository: { mode: "pinned" } }),
      trigger({ repository: { mode: "pinned", fullName: `${"a".repeat(101)}/project` } }),
      trigger({ repository: { mode: "pinned", fullName: Array(11).fill("a".repeat(100)).join("/") } }),
    ];
    for (const entry of invalid) {
      await assert.rejects(parseBotFiles(source([entry])), undefined, JSON.stringify(entry));
    }
  });

  it("previews the parsed provider, event types and nested pinned project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "librebot-gitlab-triggers-"));
    try {
      const files = source([trigger()]);
      for (const [path, contents] of Object.entries(files)) {
        if (!path.includes("/")) await writeFile(join(dir, path), contents);
      }
      const run = promisify(execFile);
      const { stdout } = await run(process.execPath, [new URL("../bin/librebot.js", import.meta.url).pathname, "preview", dir, "--json"]);
      const preview = JSON.parse(stdout);
      assert.equal(preview.draft.triggers[0].kind, "gitlab");
      assert.deepEqual(preview.draft.triggers[0].eventTypes, ["merge_request.open"]);
      assert.equal(preview.draft.triggers[0].repository.fullName, "group/subgroup/project");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
