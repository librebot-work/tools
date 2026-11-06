import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

it("previews GitLab capabilities in human and JSON output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "librebot-gitlab-preview-"));
  try {
    await writeFile(join(dir, "bot.yaml"), "formatVersion: 1\nname: GitLab\ndescription: D\nmodelRoles:\n  - {role: default, label: Main}\nworkspace:\n  - {path: ./code}\ngitlabActions: [merge_request, read_merge_request]\n");
    await writeFile(join(dir, "instructions.md"), "Be helpful.");
    const cli = fileURLToPath(new URL("../bin/librebot.js", import.meta.url));
    const text = execFileSync(process.execPath, [cli, "preview", dir], { encoding: "utf8" });
    assert.match(text, /gitlabActions: merge_request, read_merge_request/);
    const json = JSON.parse(execFileSync(process.execPath, [cli, "preview", dir, "--json"], { encoding: "utf8" }));
    assert.deepEqual(json.draft.gitlabActions, ["merge_request", "read_merge_request"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
