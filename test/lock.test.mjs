// Skill lock reproducibility: identical declarations always hash and lock
// identically; stale or mismatched locks fail closed; offline SHA pins
// need no network while branch refs refuse to resolve without it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkSourcesLock,
  parseSourcesText,
  parseSourcesYaml,
  resolveSkillsLock,
  serializeLock,
  sourcesHash,
} from "../src/index.js";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

function sink() {
  return { errors: [], warnings: [] };
}

const sourcesDoc = () => ({
  version: 1,
  sources: [{ name: "lib", source: "octo/skills", ref: SHA, skills: ["review"] }],
});

describe("skill lock reproducibility", () => {
  it("hashes declarations deterministically regardless of key order", () => {
    const parsed = parseSourcesYaml(sourcesDoc(), sink());
    assert.ok(parsed);
    const reordered = {
      version: 1,
      sources: [{ skills: ["review"], ref: SHA, source: "octo/skills", name: "lib" }],
    };
    assert.equal(sourcesHash(parseSourcesYaml(reordered, sink()).sources), sourcesHash(parsed.sources));
  });

  it("resolves SHA pins offline with byte-identical locks", async () => {
    const parsed = parseSourcesYaml(sourcesDoc(), sink());
    const first = await resolveSkillsLock({ sources: parsed });
    const second = await resolveSkillsLock({ sources: parsed });
    assert.deepEqual(first.errors, []);
    assert.equal(first.lock.resolved[0].resolvedSha, SHA);
    assert.equal(serializeLock(first.lock), serializeLock(second.lock));
  });

  it("refuses branch refs without network and resolves them with a fetcher", async () => {
    const parsed = parseSourcesYaml(
      { version: 1, sources: [{ name: "lib", source: "octo/skills", ref: "main" }] },
      sink(),
    );
    const offline = await resolveSkillsLock({ sources: parsed });
    assert.ok(offline.errors.length > 0);

    const fetchImpl = async (url) => {
      assert.match(url, /api\.github\.com/);
      return { ok: true, json: async () => ({ sha: OTHER_SHA }) };
    };
    const online = await resolveSkillsLock({ sources: parsed, network: true, fetchImpl });
    assert.deepEqual(online.errors, []);
    assert.equal(online.lock.resolved[0].resolvedSha, OTHER_SHA);
  });

  it("round-trips lock serialization and rejects stale hashes", async () => {
    const parsed = parseSourcesYaml(sourcesDoc(), sink());
    const { lock } = await resolveSkillsLock({ sources: parsed });
    const checked = checkSourcesLock(parsed, parseSourcesText(serializeLock(lock)), sink());
    assert.ok(checked);
    assert.equal(checked.resolved[0].resolvedSha, SHA);

    const stale = checkSourcesLock(parsed, { ...JSON.parse(JSON.stringify(lock)), sourcesHash: "0".repeat(64) }, sink());
    assert.equal(stale, null);
  });

  it("rejects locks that disagree with declarations", () => {
    const parsed = parseSourcesYaml(sourcesDoc(), sink());
    const tampered = {
      version: 1,
      sourcesHash: sourcesHash(parsed.sources),
      resolved: [
        { name: "lib", repo: "octo/skills", resolvedSha: OTHER_SHA, skills: ["review"] },
      ],
    };
    // SHA-declared ref must match the resolution.
    assert.equal(checkSourcesLock(parsed, tampered, sink()), null);
  });

  it("rejects malformed source specs", () => {
    assert.equal(parseSourcesYaml({ version: 99, sources: [] }, sink()), null);
  });
});
