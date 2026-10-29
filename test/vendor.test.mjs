// Vendor extraction: crafted tarballs exercise long paths, GNU longnames,
// prefix splitting, and the size caps — all offline, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { extractVendorFiles } from "../src/index.js";

function header(name, size, type = "0") {
  const block = Buffer.alloc(512, 0);
  const write = (value, offset, length) => {
    Buffer.from(value).copy(block, offset, 0, length);
    block[offset + Math.min(value.length, length)] = 0;
  };
  if (name.length <= 100) {
    write(name, 0, 100);
  } else {
    // USTAR prefix split: tests the reader's prefix handling.
    const slash = name.lastIndexOf("/", 155);
    write(name.slice(0, slash), 345, 155);
    write(name.slice(slash + 1), 0, 100);
  }
  block.write(size.toString(8).padStart(11, "0") + " ", 124);
  block[156] = type.charCodeAt(0);
  write("ustar", 257, 6);
  let checksum = 256;
  for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : block[i];
  block.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
  return block;
}

function gnuLongEntry(fullName) {
  const nameBytes = Buffer.from(fullName + "\0");
  const padded = Buffer.alloc(512 - (nameBytes.length % 512 || 512));
  return Buffer.concat([header("././@LongLink", nameBytes.length, "L"), nameBytes, padded]);
}

function tarball(entries) {
  const parts = [];
  for (const { name, data, gnuLong } of entries) {
    const bytes = Buffer.from(data);
    if (gnuLong) parts.push(gnuLongEntry(name));
    parts.push(header(gnuLong ? name.slice(-90) : name, bytes.length));
    parts.push(bytes);
    parts.push(Buffer.alloc(512 - (bytes.length % 512 || 512)));
  }
  parts.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(parts)));
}

describe("vendor extraction", () => {
  it("extracts skill subtrees and skips unselected dirs", async () => {
    const gz = tarball([
      { name: "repo-abc/review/SKILL.md", data: "# Review\n" },
      { name: "repo-abc/review/reference.md", data: "ref\n" },
      { name: "repo-abc/other/SKILL.md", data: "# Other\n" },
    ]);
    const out = await extractVendorFiles({ name: "lib", skills: ["review"] }, gz);
    assert.deepEqual(Object.keys(out).sort(), [
      "skills/.vendor/lib/review/SKILL.md",
      "skills/.vendor/lib/review/reference.md",
    ]);
    assert.equal(
      new TextDecoder().decode(out["skills/.vendor/lib/review/SKILL.md"]),
      "# Review\n",
    );
  });

  it("discovers default selections and resolves long paths", async () => {
    const longDir = "a".repeat(60) + "/" + "b".repeat(60);
    const longSkill = "x".repeat(200);
    const gz = tarball([
      { name: "repo-abc/review/SKILL.md", data: "# R\n" },
      { name: `repo-abc/${longDir}/SKILL.md`, data: "# Deep\n" },
      { name: `repo-abc/${longDir}/notes.md`, data: "deep\n" },
      { name: `repo-abc/${longSkill}/SKILL.md`, data: "# Gnu\n", gnuLong: true },
    ]);
    const out = await extractVendorFiles({ name: "lib", skills: [] }, gz);
    assert.ok(out["skills/.vendor/lib/review/SKILL.md"]);
    assert.ok(out[`skills/.vendor/lib/${longDir}/notes.md`]);
    assert.ok(out[`skills/.vendor/lib/${longSkill}/SKILL.md`]);
  });
  it("vendors dedicated single-skill repos from the source root", async () => {
    const gz = tarball([
      { name: "repo-abc/SKILL.md", data: "# Solo\n" },
      { name: "repo-abc/reference.md", data: "ref\n" },
    ]);
    const out = await extractVendorFiles({ name: "solo", skills: [] }, gz);
    assert.deepEqual(Object.keys(out).sort(), [
      "skills/.vendor/solo/SKILL.md",
      "skills/.vendor/solo/reference.md",
    ]);
    const { parseBotFiles, parseSourcesYaml, resolveSkillsLock, serializeLock } = await import("../src/index.js");
    const sha = "c".repeat(40);
    const sources = parseSourcesYaml(
      { version: 1, sources: [{ name: "solo", source: "octo/solo", ref: sha }] },
      { errors: [], warnings: [] },
    );
    const { lock, errors } = await resolveSkillsLock({ sources });
    assert.deepEqual(errors, []);
    const reparsed = await parseBotFiles({
      "bot.yaml":
        "formatVersion: 1\nname: T\ndescription: D\nmodelRoles:\n  - role: default\n    label: Main\n",
      "instructions.md": "Hi.",
      "skills/sources.yaml": `version: 1\nsources:\n  - name: solo\n    source: octo/solo\n    ref: ${sha}\n`,
      "skills/sources.lock": serializeLock(lock),
      ...out,
    });
    assert.equal(reparsed.draft.skills.length, 1);
    assert.equal(reparsed.skillFiles.length, 1);
    assert.equal(new TextDecoder().decode(reparsed.skillFiles[0].bytes), "ref\n");
  });

  it("rejects tarballs with traversal paths", async () => {
    const { readTarEntries } = await import("../src/index.js");
    const { gunzipSync } = await import("node:zlib");
    const evil = tarball([{ name: "repo-abc/../../evil.md", data: "x\n" }]);
    const raw = gunzipSync(Buffer.from(evil));
    assert.throws(() => readTarEntries(new Uint8Array(raw)), /unsafe/);
  });

  it("fails loudly on oversized selected files instead of partial trees", async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 1);
    const gzBig = new Uint8Array(
      gzipSync(
        Buffer.concat([header("repo-abc/big/blob.bin", big.length), big, Buffer.alloc(1024)]),
      ),
    );
    await assert.rejects(
      extractVendorFiles({ name: "lib", skills: ["big"] }, gzBig),
      /exceeds the size limit/,
    );
  });
});
