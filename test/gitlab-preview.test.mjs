import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

it("previews portable repository capabilities in human and JSON output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "librebot-gitlab-preview-"));
  try {
    await writeFile(join(dir, "bot.yaml"), "formatVersion: 1\nname: Repository\ndescription: D\nmodelRoles:\n  - {role: default, label: Main}\nworkspace:\n  - {key: source, path: ./code}\nactions:\n  - {key: repo, kind: gitrepo, capabilities: [propose_change, read_change_request]}\n");
    await writeFile(join(dir, "instructions.md"), "Be helpful.");
    const cli = fileURLToPath(new URL("../bin/librebot.js", import.meta.url));
    const text = execFileSync(process.execPath, [cli, "preview", dir], { encoding: "utf8" });
    assert.ok(text.length > 0);
    const json = JSON.parse(execFileSync(process.execPath, [cli, "preview", dir, "--json"], { encoding: "utf8" }));
    assert.deepEqual(json.draft.actions, [{ key: "repo", kind: "gitrepo", capabilities: ["propose_change", "read_change_request"] }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
