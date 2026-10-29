// Skill dependencies resolve locally and are committed as immutable vendor files.
// Explicit GitHub commit pins use bounded HTTP downloads; other standard skills
// locators are installed by the pinned skills CLI only with explicit network consent.

import { createGunzip } from "node:zlib";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { isRecord } from "./errors.js";
import { canonicalJson, sha256Hex } from "./util.js";
import { vendorContentHash } from "./skills-import.js";
import { entryId } from "./validate.js";

export const LOCK_VERSION = 1;
export const SOURCES_VERSION = 1;

const SHA_RE = /^[0-9a-f]{40}$/;
const SHORTHAND_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

function err(sink, file, field, message) {
  sink.errors.push({ file, field, message });
}

/**
 * Normalize GitHub repository pins or preserve a standard skills CLI locator.
 */
export function parseRepo(source) {
  const raw = String(source ?? "").trim().replace(/\/+$/, "");
  const generic = () => raw && raw.length <= 2000 && !raw.startsWith("-") && !/[\0\r\n]/.test(raw)
    ? { owner: "skills-cli", repo: raw, url: raw, source: raw } : null;
  if (SHORTHAND_RE.test(raw)) {
    const [owner, repo] = raw.split("/");
    return { owner, repo: repo.replace(/\.git$/, ""), url: `https://github.com/${owner}/${repo.replace(/\.git$/, "")}` };
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return generic();
  }
  if (parsed.password || (parsed.protocol === "https:" && parsed.username)) return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parts.length !== 2) return generic();
  return {
    owner: parts[0],
    repo: parts[1].replace(/\.git$/, ""),
    url: `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/, "")}`,
  };
}

/**
 * Validate a parsed sources.yaml document.
 * @returns {{ version: 1; sources: Array<{ name: string; repo: { owner: string; repo: string; url: string }; ref: string|undefined; skills: string[] }> }|null}
 */
export function parseSourcesYaml(doc, sink) {
  const file = "skills/sources.yaml";
  if (!isRecord(doc)) {
    err(sink, file, "", "must be a YAML mapping");
    return null;
  }
  if (doc.version !== SOURCES_VERSION) {
    err(sink, file, "version", `must be ${SOURCES_VERSION}`);
    return null;
  }
  if (!Array.isArray(doc.sources)) {
    err(sink, file, "sources", "must be an array");
    return null;
  }
  if (doc.sources.length > 50) {
    err(sink, file, "sources", "has too many entries (max 50)");
    return null;
  }
  const seen = {};
  const sources = [];
  let ok = true;
  doc.sources.forEach((rawEntry, i) => {
    const entry = typeof rawEntry === "string" ? { name: "source-" + sha256Hex(new TextEncoder().encode(rawEntry)).slice(0, 12), source: rawEntry } : rawEntry;
    const field = `sources[${i}]`;
    if (!isRecord(entry)) {
      err(sink, file, field, "must be an object");
      ok = false;
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!["name", "source", "ref", "skills"].includes(key)) {
        err(sink, file, field, `contains unsupported field ${key}`);
        ok = false;
      }
    }
    const name = entryId(entry.name, field, sink, file);
    if (name === undefined) {
      ok = false;
      return;
    }
    if (seen[name]) {
      err(sink, file, field, `contains duplicate source ${name}`);
      ok = false;
      return;
    }
    seen[name] = true;
    let repo = parseRepo(entry.source);
    if (!repo) {
      err(
        sink,
        file,
        `${field}.source`,
        "must be a non-empty skills CLI source locator without embedded credentials",
      );
      ok = false;
      return;
    }
    // Without an explicit GitHub ref, delegate discovery and default branches
    // to the same CLI developers use with `npx skills`.
    if (entry.ref === undefined && !repo.source) repo = { owner: "skills-cli", repo: String(entry.source).trim(), url: String(entry.source).trim(), source: String(entry.source).trim() };
    if (repo.source && entry.ref !== undefined) {
      err(sink, file, `${field}.ref`, "encode the ref in the skills source locator for this source format");
      ok = false;
      return;
    }
    let ref;
    if (entry.ref !== undefined) {
      if (typeof entry.ref !== "string" || !entry.ref.trim() || entry.ref.length > 256) {
        err(sink, file, `${field}.ref`, "must be a branch, tag, or commit SHA");
        ok = false;
        return;
      }
      ref = entry.ref.trim();
    }
    let skills = [];
    if (entry.skills !== undefined) {
      if (!Array.isArray(entry.skills) || entry.skills.length > 50) {
        err(sink, file, `${field}.skills`, "must be an array of at most 50 skill names");
        ok = false;
        return;
      }
      for (let j = 0; j < entry.skills.length; j++) {
        const skill = entry.skills[j];
        if (typeof skill !== "string" || !skill.trim() || skill.trim().startsWith("-") || /[\0\r\n]/.test(skill) || skill.length > 100) {
          err(sink, file, `${field}.skills[${j}]`, "must be a non-empty string up to 100 chars");
          ok = false;
          return;
        }
        skills.push(skill.trim());
      }
    }
    sources.push({ name, repo, ref, skills });
  });
  return ok ? { version: SOURCES_VERSION, sources } : null;
}

/** Stable hash of the normalized source declarations. */
export function sourcesHash(sources) {
  return sha256Hex(
    new TextEncoder().encode(
      canonicalJson(
        sources.map((s) => ({
          name: s.name,
          repo: `${s.repo.owner}/${s.repo.repo}`,
          ref: s.ref ?? null,
          skills: [...s.skills].sort(),
        })),
      ),
    ),
  );
}

function validResolved(entry) {
  return (
    isRecord(entry) &&
    typeof entry.name === "string" &&
    typeof entry.repo === "string" &&
    ((typeof entry.resolvedSha === "string" && SHA_RE.test(entry.resolvedSha)) ||
      (typeof entry.contentSha256 === "string" && /^[0-9a-f]{64}$/.test(entry.contentSha256))) &&
    (entry.tarballSha256 === undefined || /^[0-9a-f]{64}$/.test(entry.tarballSha256)) &&
    Array.isArray(entry.skills)
  );
}

/**
 * Validate sources.lock against parsed sources.yaml. Fails stale locks so a
 * pinned bot can never silently follow a changed declaration.
 */
export function checkSourcesLock(parsedSources, lockDoc, sink) {
  const file = "skills/sources.lock";
  if (!isRecord(lockDoc)) {
    err(sink, file, "", "must be a YAML mapping");
    return null;
  }
  if (lockDoc.version !== LOCK_VERSION) {
    err(sink, file, "version", `must be ${LOCK_VERSION}`);
    return null;
  }
  if (!Array.isArray(lockDoc.resolved)) {
    err(sink, file, "resolved", "must be an array");
    return null;
  }
  const expected = sourcesHash(parsedSources.sources);
  if (lockDoc.sourcesHash !== expected) {
    err(sink, file, "sourcesHash", "is stale: re-run `librebot resolve-skills`");
    return null;
  }
  const byName = new Map(parsedSources.sources.map((s) => [s.name, s]));
  const resolved = [];
  for (let i = 0; i < lockDoc.resolved.length; i++) {
    const entry = lockDoc.resolved[i];
    if (!validResolved(entry)) {
      err(sink, file, `resolved[${i}]`, "is malformed");
      return null;
    }
    const declared = byName.get(entry.name);
    if (!declared) {
      err(sink, file, `resolved[${i}]`, `resolves undeclared source ${entry.name}`);
      return null;
    }
    if (entry.repo !== `${declared.repo.owner}/${declared.repo.repo}`) {
      err(sink, file, `resolved[${i}].repo`, "does not match skills/sources.yaml");
      return null;
    }
    const declaredSkills = [...declared.skills].sort();
    const lockedSkills = [...entry.skills].sort();
    if (JSON.stringify(declaredSkills) !== JSON.stringify(lockedSkills)) {
      err(sink, file, `resolved[${i}].skills`, "does not match skills/sources.yaml");
      return null;
    }
    if (
      declared.ref !== undefined &&
      SHA_RE.test(declared.ref) &&
      declared.ref.toLowerCase() !== entry.resolvedSha
    ) {
      err(sink, file, `resolved[${i}].resolvedSha`, "does not match the pinned ref");
      return null;
    }
    byName.delete(entry.name);
    resolved.push({
      name: entry.name,
      repo: entry.repo,
      resolvedSha: entry.resolvedSha,
      tarballSha256: entry.tarballSha256,
      ...(entry.contentSha256 ? { contentSha256: entry.contentSha256 } : {}),
      skills: [...entry.skills],
    });
  }
  if (byName.size > 0) {
    err(
      sink,
      file,
      "resolved",
      `missing resolutions for: ${[...byName.keys()].join(", ")}`,
    );
    return null;
  }
  return { version: LOCK_VERSION, sourcesHash: expected, resolved, vendorDirs: [] };
}

export function serializeLock(lock) {
  return stringifyYaml({
    version: LOCK_VERSION,
    sourcesHash: lock.sourcesHash,
    resolved: lock.resolved.map((r) => ({
      name: r.name,
      repo: r.repo,
      ...(r.resolvedSha ? { resolvedSha: r.resolvedSha } : {}),
      ...(r.contentSha256 ? { contentSha256: r.contentSha256 } : {}),
      ...(r.tarballSha256 ? { tarballSha256: r.tarballSha256 } : {}),
      skills: r.skills,
    })),
  });
}

async function resolveRefToSha(repo, ref, fetchImpl) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(ref)}`,
    { headers: { Accept: "application/vnd.github+json" } },
  );
  if (!response.ok) {
    throw new Error(`could not resolve ${repo.owner}/${repo.repo}@${ref} (HTTP ${response.status})`);
  }
  const body = await response.json();
  if (typeof body?.sha !== "string" || !SHA_RE.test(body.sha)) {
    throw new Error(`could not resolve ${repo.owner}/${repo.repo}@${ref}: bad response`);
  }
  return body.sha;
}

export const MAX_TARBALL_BYTES = 20 * 1024 * 1024;
export const MAX_DECOMPRESSED_BYTES = 100 * 1024 * 1024;

/**
 * Read a byte stream enforcing a hard cap while reading: the cap trips
 * before the full payload is allocated, so a small compressed response
 * hiding a huge expansion cannot exhaust memory first.
 */
async function readCappedStream(stream, maxBytes, what) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`${what} exceeds the ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function fetchTarball(repo, sha, fetchImpl) {
  const response = await fetchImpl(
    `https://codeload.github.com/${repo.owner}/${repo.repo}/tar.gz/${sha}`,
  );
  if (!response.ok) {
    throw new Error(`could not download ${repo.owner}/${repo.repo}@${sha} (HTTP ${response.status})`);
  }
  if (response.body !== undefined && response.body !== null && typeof response.body.getReader === "function") {
    return readCappedStream(response.body, MAX_TARBALL_BYTES, "tarball");
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.length > MAX_TARBALL_BYTES) {
    throw new Error(`tarball exceeds the ${MAX_TARBALL_BYTES} byte limit`);
  }
  return buffer;
}

/**
 * Resolve sources.yaml to a lock. SHA-pinned refs resolve offline;
 * branch/tag refs need `network: true`. With `vendor: true`, pinned
 * tarballs are downloaded (hash recorded) and vendor file maps returned.
 * Standard CLI locators require explicit network consent and vendoring.
 */
export async function resolveSkillsLock({
  sources,
  existingLock,
  update = false,
  network = false,
  vendor = false,
  fetchImpl = globalThis.fetch,
  sourceBaseDir,
  currentFiles = {},
}) {
  const errors = [];
  const warnings = [];
  const resolved = [];
  /** @type {Record<string, Uint8Array>} */
  const vendorFiles = {};
  for (const source of sources.sources) {
    const label = `sources.${source.name}`;
    const prior = existingLock?.resolved?.find((r) => r.name === source.name);
    if (source.repo.source) {
      try {
        const same = prior?.repo === `${source.repo.owner}/${source.repo.repo}` &&
          JSON.stringify([...(prior.skills ?? [])].sort()) === JSON.stringify([...source.skills].sort());
        const prefix = `skills/.vendor/${source.name}/`;
        const retained = Object.fromEntries(Object.entries(currentFiles).filter(([path]) => path.startsWith(prefix)));
        if (same && !update && prior.contentSha256 && Object.keys(retained).length &&
            vendorContentHash(retained, prefix) === prior.contentSha256) {
          resolved.push(prior);
          if (vendor) Object.assign(vendorFiles, retained);
          continue;
        }
        if (same && !update && !vendor) { resolved.push(prior); continue; }
        if (!network || !vendor) throw new Error("run resolve-skills --network --vendor to install this skills CLI source");
        const { importSkillSource } = await import("./skills-import.js");
        const installed = await importSkillSource(source, { sourceBaseDir });
        if (same && !update && prior.contentSha256 && installed.contentSha256 !== prior.contentSha256) throw new Error("installed content differs from the lock; use --update to adopt it");
        resolved.push({ name: source.name, repo: `${source.repo.owner}/${source.repo.repo}`, contentSha256: installed.contentSha256, skills: [...source.skills] });
        Object.assign(vendorFiles, installed.files);
      } catch (error) { errors.push({ file: "skills/sources.yaml", field: label, message: error.message }); }
      continue;
    }
    const sameDecl =
      prior !== undefined &&
      prior.repo === `${source.repo.owner}/${source.repo.repo}` &&
      JSON.stringify([...prior.skills].sort()) ===
        JSON.stringify([...source.skills].sort()) &&
      (source.ref === undefined ||
        (SHA_RE.test(source.ref) &&
          source.ref.toLowerCase() === prior.resolvedSha));
    if (prior !== undefined && sameDecl && !update) {
      resolved.push({ ...prior, skills: [...prior.skills] });
      if (vendor) {
        try {
          const downloaded = await fetchTarball(source.repo, prior.resolvedSha, fetchImpl);
          if (prior.tarballSha256 !== undefined && sha256Hex(downloaded) !== prior.tarballSha256) {
            throw new Error(`${label}: tarball hash mismatch for pinned ${prior.resolvedSha}`);
          }
          Object.assign(vendorFiles, await extractVendorFiles(source, downloaded));
          const found = resolved[resolved.length - 1];
          if (found.tarballSha256 === undefined) {
            found.tarballSha256 = sha256Hex(downloaded);
          }
        } catch (error) {
          errors.push({ file: "skills/sources.yaml", field: label, message: error.message });
        }
      }
      continue;
    }
    if (source.ref === undefined) {
      errors.push({
        file: "skills/sources.yaml",
        field: label,
        message: "needs an explicit ref (branch, tag, or commit SHA)",
      });
      continue;
    }
    let sha;
    if (SHA_RE.test(source.ref)) {
      sha = source.ref.toLowerCase();
    } else if (network) {
      try {
        sha = await resolveRefToSha(source.repo, source.ref, fetchImpl);
      } catch (error) {
        errors.push({ file: "skills/sources.yaml", field: label, message: error.message });
        continue;
      }
    } else {
      errors.push({ file: "skills/sources.yaml", field: label, message: `ref ${source.ref} is not a commit SHA: pin a SHA or re-run with network access` });
      continue;
    }
    // A recorded tarball hash authenticates exactly one pinned archive:
    // carry it only when repo and SHA are identical, otherwise a real
    // update would always fail against the previous archive's hash.
    const samePin =
      prior?.repo === `${source.repo.owner}/${source.repo.repo}` &&
      prior?.resolvedSha === sha;
    const entry = {
      name: source.name,
      repo: `${source.repo.owner}/${source.repo.repo}`,
      resolvedSha: sha,
      tarballSha256: samePin ? prior?.tarballSha256 : undefined,
      skills: [...source.skills],
    };
    if (vendor) {
      try {
        const downloaded = await fetchTarball(source.repo, sha, fetchImpl);
        if (entry.tarballSha256 !== undefined && sha256Hex(downloaded) !== entry.tarballSha256) {
          throw new Error(`${label}: tarball hash mismatch for pinned ${sha}`);
        }
        entry.tarballSha256 = sha256Hex(downloaded);
        Object.assign(vendorFiles, await extractVendorFiles(source, downloaded));
      } catch (error) {
        errors.push({ file: "skills/sources.yaml", field: label, message: error.message });
        continue;
      }
    } else if (entry.tarballSha256 === undefined) {
      warnings.push({
        file: "skills/sources.yaml",
        field: label,
        message: "locked without a tarball hash: run with --vendor to record one",
      });
    }
    resolved.push(entry);
  }
  const lock = {
    version: LOCK_VERSION,
    sourcesHash: sourcesHash(sources.sources),
    resolved,
    vendorDirs: [],
  };
  return { lock, vendorFiles, errors, warnings };
}

/**
 * Download every locked tarball (verifying hashes) and extract vendor files.
 * Returns `{ vendorFiles, errors }`; vendorFiles keys are repo-relative
 * `skills/.vendor/<name>/...` paths for direct commit into the source tree.
 */
export async function fetchLockedSkills(lock, { fetchImpl = globalThis.fetch } = {}) {
  const errors = [];
  /** @type {Record<string, Uint8Array>} */
  const vendorFiles = {};
  for (const entry of lock.resolved ?? []) {
    const [owner, repo] = String(entry.repo).split("/");
    try {
      if (entry.contentSha256) throw new Error("content-locked CLI sources restore from committed vendor files; use resolve-skills --network --vendor to fetch and verify them locally");
      const downloaded = await fetchTarball({ owner, repo }, entry.resolvedSha, fetchImpl);
      if (entry.tarballSha256 !== undefined && sha256Hex(downloaded) !== entry.tarballSha256) {
        throw new Error(`tarball hash mismatch for pinned ${entry.resolvedSha}`);
      }
      Object.assign(
        vendorFiles,
        await extractVendorFiles(
          { name: entry.name, skills: entry.skills ?? [] },
          downloaded,
        ),
      );
    } catch (error) {
      errors.push({ file: "skills/sources.lock", field: entry.name, message: error.message });
    }
  }
  return { vendorFiles, errors };
}

export function parseSourcesText(text) {
  return parseYaml(text);
}

// --- tarball extraction (no shell, no command execution) ---

const MAX_VENDOR_FILES = 200;
// Supporting files use the same binary MiB bound as platform validation.
const MAX_VENDOR_FILE_BYTES = 1024 * 1024;
// Tar-level bounds enforced while reading, before bytes are copied: they
const MAX_TAR_ENTRIES = 5000;
// Copy cap matches the 10,000,000-byte knowledge-asset ceiling so no valid
// file is ever skipped at the transport layer; policy caps (1 MB skill
// files, selected-output limits) still decide what gets vendored.
const MAX_TAR_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TAR_HEADER_BYTES = 64 * 1024;

async function gunzip(bytes) {
  return new Promise((resolve, reject) => {
    const gunzipStream = createGunzip();
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      gunzipStream.destroy();
      reject(error);
    };
    gunzipStream.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_DECOMPRESSED_BYTES) {
        fail(new Error(`decompressed tarball exceeds the ${MAX_DECOMPRESSED_BYTES} byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    gunzipStream.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    gunzipStream.on("error", fail);
    gunzipStream.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  });
}

/**
 * Minimal tar reader: regular files only, deterministic order. Handles the
 * USTAR prefix field plus GNU longname (`L`) and PAX extended-header (`x`)
 * path overrides, so skill trees with long supporting paths extract
 * completely. Symlinks, hardlinks, devices, and other special entries are
 * skipped; absolute or `..`-containing paths throw, so no yielded entry
 * can escape its destination. Entry-count, per-file, and header caps are
 * enforced while reading, before bytes are copied. Exported for
 * server-side archive ingestion that needs the same guarantees.
 */
export function readTarEntries(buffer) {
  // Entries record `skipped: true` instead of copying bytes once the
  // per-file copy cap trips: huge unrelated files never get allocated,
  // while the extractor can still fail loudly if a *selected* file was
  // skipped rather than silently vendoring a partial tree.
  /** @type {Array<{ name: string; bytes: Uint8Array; skipped: boolean }>} */
  const out = [];
  let offset = 0;
  let pendingLongName = null;
  let pendingPaxPath = null;
  let entryCount = 0;
  const text = (start, length) => {
    let end = start;
    while (end < start + length && buffer[end] !== 0) end++;
    return new TextDecoder().decode(buffer.slice(start, end));
  };
  const decodeDataText = (start, size) => {
    if (size > MAX_TAR_HEADER_BYTES) {
      throw new Error("tarball has an oversized header entry");
    }
    const bytes = buffer.slice(start, start + size);
    let end = bytes.length;
    const nul = bytes.indexOf(0);
    if (nul >= 0) end = nul;
    return new TextDecoder().decode(bytes.slice(0, end));
  };
  while (offset + 512 <= buffer.length) {
    const rawName = text(offset, 100);
    const prefix = text(offset + 345, 155);
    if (!rawName && !prefix && pendingLongName === null && pendingPaxPath === null) break;
    entryCount++;
    if (entryCount > MAX_TAR_ENTRIES) {
      throw new Error(`tarball has too many entries (max ${MAX_TAR_ENTRIES})`);
    }
    const size = parseInt(text(offset + 124, 12).trim() || "0", 8);
    const typeFlag = String.fromCharCode(buffer[offset + 156] ?? 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (!Number.isFinite(size) || size < 0 || dataEnd > buffer.length) break;
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (typeFlag === "L") {
      pendingLongName = decodeDataText(dataStart, size);
      continue;
    }
    if (typeFlag === "x" || typeFlag === "g") {
      const paxPath = parsePaxPath(decodeDataText(dataStart, size));
      if (paxPath !== null) pendingPaxPath = paxPath;
      continue;
    }
    const headerName = prefix ? `${prefix}/${rawName}` : rawName;
    const name = pendingLongName ?? pendingPaxPath ?? headerName;
    pendingLongName = null;
    pendingPaxPath = null;
    if (!name) continue;
    if (name.startsWith("/") || name.split("/").some((segment) => segment === "..")) {
      throw new Error("tarball has an unsafe entry path");
    }
    if (typeFlag === "0" || typeFlag === "\0") {
      if (size > MAX_TAR_FILE_BYTES) {
        out.push({ name, bytes: new Uint8Array(0), skipped: true });
      } else {
        out.push({ name, bytes: buffer.slice(dataStart, dataEnd), skipped: false });
      }
    }
  }
  return out;
}

/** Extract the `path=` override from PAX extended-header records. */
function parsePaxPath(records) {
  for (const line of records.split("\n")) {
    const match = /^\d+ path=(.*)$/.exec(line.replace(/\0+$/, ""));
    if (match) return match[1];
  }
  return null;
}

/**
 * Extract a pinned tarball into `skills/.vendor/<name>/...`, selecting only
 * the locked skill subtrees (plus their supporting files). Skips dotfiles,
 * symlinks are never materialized (USTAR reader takes files only).
 */
export async function extractVendorFiles(source, tarball) {
  const tar = readTarEntries(await gunzip(tarball));
  /** @type {Record<string, Uint8Array>} */
  const vendorFiles = {};
  const wanted = [...source.skills];
  // Strip the `<repo>-<sha>/` prefix codeload prepends.
  const entries = [];
  for (const entry of tar) {
    const slash = entry.name.indexOf("/");
    if (slash < 0) continue;
    entries.push({ name: entry.name.slice(slash + 1), bytes: entry.bytes, skipped: entry.skipped });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  let roots;
  if (wanted.length > 0) {
    roots = wanted.map((s) => s.replace(/\/+$/, "") + "/");
  } else {
    // No skill selection: vendor top-level dirs containing SKILL.md — plus
    // the source root itself when the repo is one dedicated skill
    // (root-level SKILL.md), matching the parser's .vendor/<name>/ fallback.
    const skillRoots = new Set();
    for (const entry of entries) {
      if (entry.name === "SKILL.md") {
        skillRoots.add("");
      } else if (entry.name.endsWith("/SKILL.md")) {
        skillRoots.add(entry.name.slice(0, entry.name.length - "SKILL.md".length));
      }
    }
    roots = [...skillRoots].filter(
      (root) => root.split("/").filter(Boolean).length <= 2,
    );
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.name.split("/").some((s) => s.startsWith("."))) continue;
    if (!roots.some((root) => entry.name === root + "SKILL.md" || entry.name.startsWith(root))) {
      continue;
    }
    if (entry.skipped) {
      throw new Error(`vendored file ${entry.name} exceeds the size limit`);
    }
    if (entry.bytes.length > MAX_VENDOR_FILE_BYTES) {
      throw new Error(`vendored file ${entry.name} exceeds the size limit`);
    }
    count++;
    if (count > MAX_VENDOR_FILES) {
      throw new Error("vendored skill tree has too many files");
    }
    vendorFiles[`skills/.vendor/${source.name}/${entry.name}`] = entry.bytes;
  }
  const hasSkillDoc = Object.keys(vendorFiles).some((k) => k.endsWith("/SKILL.md") || k.endsWith("SKILL.md"));
  if (!hasSkillDoc) {
    throw new Error(`no SKILL.md found for the locked skill selection`);
  }
  return vendorFiles;
}
