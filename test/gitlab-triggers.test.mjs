import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { parseBotFiles, scaffoldBotFiles, exportBotFiles } from "../src/index.js";
import { GITREPO_TRIGGER_EVENT_TYPES } from "../src/contract.js";

const trigger = (overrides = {}) => ({ key: "project-events", label: "Project events", kind: "gitrepo", eventTypes: ["change_request.opened"], deciderInstructions: "Decide whether to act", deciderActions: [], ...overrides });
const source = (triggers) => ({ ...scaffoldBotFiles({ name: "Triggers" }), "bot.yaml": `formatVersion: 1\ndescription: D\nmodelRoles: [{role: default, label: Main}]\nactions: [{key: repo, kind: gitrepo, capabilities: [read_change_request, merge_change_request]}]\ntriggers: ${JSON.stringify(triggers)}\n` });

describe("Portable repository trigger authoring", () => {
  it("round-trips every semantic event and preserves explicit keys across label edits", async () => {
    const deciderActions = [{ action: "repo", capabilities: ["read_change_request"] }];
    const initial = await parseBotFiles(source([trigger({ eventTypes: GITREPO_TRIGGER_EVENT_TYPES, deciderActions })]));
    assert.equal(initial.draft.triggers[0].kind, "gitrepo");
    const roundtrip = await parseBotFiles(exportBotFiles(initial.draft));
    assert.deepEqual(roundtrip.draft.triggers, initial.draft.triggers);
    assert.deepEqual(roundtrip.draft.triggers[0].deciderActions, deciderActions);
    const renamed = await parseBotFiles(source([trigger({ label: "Renamed events" })]));
    assert.equal(renamed.draft.triggers[0].key, initial.draft.triggers[0].key);
  });

  it("rejects native kinds, native events, duplicate events and pinned targets", async () => {
    const invalid = [
      trigger({ kind: "gitlab" }), trigger({ kind: "github" }),
      trigger({ eventTypes: ["issues.opened"] }),
      trigger({ eventTypes: ["merge_request.open"] }), trigger({ eventTypes: ["unknown"] }),
      trigger({ eventTypes: ["repository.pushed", "repository.pushed"] }),
      trigger({ repository: { mode: "pinned", fullName: "group/subgroup/project" } }),
      trigger({ key: "" }),
    ];
    for (const entry of invalid) {
      await assert.rejects(parseBotFiles(source([entry])), undefined, JSON.stringify(entry));
    }
  });

  it("previews the parsed semantic trigger and stable key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "librebot-gitlab-triggers-"));
    try {
      const deciderActions = [{ action: "repo", capabilities: ["read_change_request"] }];
      const files = source([trigger({ deciderActions })]);
      for (const [path, contents] of Object.entries(files)) {
        if (!path.includes("/")) await writeFile(join(dir, path), contents);
      }
      const run = promisify(execFile);
      const cli = new URL("../bin/librebot.js", import.meta.url).pathname;
      const { stdout } = await run(process.execPath, [cli, "preview", dir, "--json"]);
      const preview = JSON.parse(stdout);
      assert.equal(preview.draft.triggers[0].kind, "gitrepo");
      assert.deepEqual(preview.draft.triggers[0].eventTypes, ["change_request.opened"]);
      assert.equal(preview.draft.triggers[0].key, "project-events");
      assert.deepEqual(preview.draft.triggers[0].deciderActions, deciderActions);
      assert.equal(preview.deciderActionAuthority, "not_evaluated");
      const text = await run(process.execPath, [cli, "preview", dir]);
      assert.match(text.stdout, /Router native actions \(valid source declarations\): repo \(read_change_request\)/);
      assert.match(text.stdout, /Instance authority not evaluated/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
