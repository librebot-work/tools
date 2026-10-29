// Stateless bot-source parser. Operates on an in-memory file map
// (Record<posix-rel-path, Uint8Array|string>) so Forgejo trees, zips, and
// local directories all parse identically with zero filesystem access.
// Fully offline: external skills must be vendored under skills/.vendor/.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { BotSourceError, isRecord } from "./errors.js";
import { checkSourcesLock, parseSourcesYaml } from "./skills-lock.js";
import { sha256Hex, toBytes } from "./util.js";
import { vendorContentHash } from "./skills-import.js";
import {
  FORMAT_VERSION,
  entryId,
  requiredString,
  validateConnectors,
  validateGithubActions,
  validateKnowledgeSources,
  validateModelRoles,
  validateTriggerDefinitions,
  validateWorkspaceMounts,
} from "./validate.js";

const FILE_BOT_YAML = "bot.yaml";
const FILE_INSTRUCTIONS = "instructions.md";
const DIR_KNOWLEDGE = "knowledge/";
const DIR_SKILLS = "skills/";
const DIR_VENDOR = "skills/.vendor/";
const FILE_SOURCES = "skills/sources.yaml";
const FILE_LOCK = "skills/sources.lock";
const KNOWLEDGE_INDEX = "knowledge/README.md";

const TOP_LEVEL_KEYS = [
  "formatVersion",
  "name",
  "description",
  "modelRoles",
  "workspace",
  "triggers",
  "githubActions",
  "connectors",
  "knowledgeSources",
];

export const MAX_TEXT_KNOWLEDGE_BYTES = 100_000;
export const MAX_SKILL_BYTES = 50_000;
// Binary byte limits match platform validation.
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;
export const MAX_DRAFT_BYTES = 750_000;
export const MAX_FILES = 5000;
export const MAX_SKILL_FILES = 100;
export const MAX_SKILL_FILE_BYTES = 1024 * 1024;

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".md": "text/markdown",
  ".txt": "text/plain",
};


/**
 * Normalize + validate a caller-supplied file map. Keys must be posix-style
 * relative paths (no leading slash, no backslash, no `..` segments).
 * @param {Record<string, Uint8Array|string>} files
 * @returns {Map<string, Uint8Array>} sorted by path (deterministic)
 */
export function normalizeFileMap(files) {
  if (!isRecord(files)) throw new Error("files must be an object");
  const out = new Map();
  for (const [rawPath, value] of Object.entries(files)) {
    if (typeof rawPath !== "string" || !rawPath || rawPath.startsWith("/")) {
      throw new Error(`invalid file path: ${rawPath}`);
    }
    const path = rawPath.replace(/\\/g, "/");
    const segments = path.split("/");
    if (segments.some((s) => s === "" || s === "." || s === "..")) {
      throw new Error(`invalid file path: ${rawPath}`);
    }
    if (out.has(path)) throw new Error(`duplicate file path: ${rawPath}`);
    out.set(path, toBytes(value));
  }
  if (out.size > MAX_FILES) throw new Error(`too many files (max ${MAX_FILES})`);
  return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Paths the parser ignores (dotfiles), except inside the vendor tree. */
function isSkipped(path) {
  if (path.startsWith(DIR_VENDOR)) return false;
  return path.split("/").some((segment) => segment.startsWith("."));
}

/** Strict UTF-8 text, or null when the bytes are binary. Length caps apply at the call site in chars, matching the platform. */
function asInlineText(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) return null;
    return text;
  } catch {
    return null;
  }
}

function mimeFor(path) {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function baseName(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Deterministic knowledge id derived from the path under knowledge/. */
export function knowledgeIdFor(rel) {
  let id = rel.replace(/\//g, "__").replace(/[^A-Za-z0-9._-]/g, "_");
  if (!/^[A-Za-z0-9]/.test(id)) id = "k_" + id;
  return id.slice(0, 64);
}

/**
 * Parse SKILL.md frontmatter (`name:`/`description:` between `---` fences).
 * @returns {{ name?: string; description?: string; body: string }}
 */
export function parseSkillFrontmatter(text) {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { body: text };
  }
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { body: text };
  const head = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  /** @type {{ name?: string; description?: string; body: string }} */
  const out = { body };
  for (const line of head.split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, raw] = match;
    const value = raw.trim().replace(/^["']|["']$/g, "");
    if ((key === "name" || key === "description") && value) out[key] = value;
  }
  return out;
}

/** First `# heading` in markdown, for a skill display name fallback. */
function firstHeading(text) {
  for (const line of text.split("\n")) {
    const match = /^#{1,3}\s+(.+)$/.exec(line.trim());
    if (match) return match[1].trim().slice(0, 200);
  }
  return undefined;
}

/**
 * @param {Map<string, Uint8Array>} files
 * @param {{ errors: Array<{file:string;field:string;message:string}>; warnings: Array<{file:string;field:string;message:string}> }} sink
 */
function readYamlFile(files, path, sink) {
  const bytes = files.get(path);
  if (bytes === undefined) return undefined;
  let doc;
  try {
    doc = parseYaml(new TextDecoder().decode(bytes));
  } catch (error) {
    sink.errors.push({
      file: path,
      field: "",
      message: `is not valid YAML: ${error.message}`,
    });
    return undefined;
  }
  return doc;
}

/**
 * Parse + semantically validate a bot source tree.
 * @param {Record<string, Uint8Array|string>} input
 * @returns {Promise<{ formatVersion: number; draft: Record<string, unknown>; assets: Array<{ knowledgeId: string; path: string; bytes: Uint8Array; sha256: string; size: number; mime: string }>; skillFiles: Array<{ skillId: string; path: string; bytes: Uint8Array; sha256: string; size: number }>; warnings: Array<{file:string;field:string;message:string}>; source: Record<string, unknown>; lock: Record<string, unknown> | null }>}
 */
export async function parseBotFiles(input) {
  const result = await validateFiles(input);
  if (!result.ok) {
    throw new BotSourceError(result.errors, result.warnings);
  }
  return {
    formatVersion: result.formatVersion,
    draft: result.draft,
    assets: result.assets,
    skillFiles: result.skillFiles,
    warnings: result.warnings,
    source: result.source,
    lock: result.lock,
  };
}

/** Non-throwing variant of parseBotFiles for CLI/server ingestion. */
export async function validateFiles(input) {
  /** @type {Array<{file:string;field:string;message:string}>} */
  const errors = [];
  /** @type {Array<{file:string;field:string;message:string}>} */
  const warnings = [];
  const sink = { errors, warnings };
  /** @type {Map<string, Uint8Array>} */
  let files;
  try {
    files = normalizeFileMap(input);
  } catch (error) {
    return { ok: false, errors: [{ file: "", field: "", message: error.message }], warnings };
  }

  const botDoc = readYamlFile(files, FILE_BOT_YAML, sink);
  if (!files.has(FILE_BOT_YAML)) {
    errors.push({ file: FILE_BOT_YAML, field: "", message: "is required" });
  }
  const instructionsBytes = files.get(FILE_INSTRUCTIONS);
  if (instructionsBytes === undefined) {
    errors.push({ file: FILE_INSTRUCTIONS, field: "", message: "is required" });
  }
  if (botDoc === undefined || instructionsBytes === undefined) {
    return { ok: false, errors, warnings };
  }
  if (!isRecord(botDoc)) {
    errors.push({ file: FILE_BOT_YAML, field: "", message: "must be a YAML mapping" });
    return { ok: false, errors, warnings };
  }
  for (const key of Object.keys(botDoc)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      errors.push({
        file: FILE_BOT_YAML,
        field: key,
        message:
          key === "tools"
            ? "was removed: builtin tools are always on and must not be declared"
            : `contains unsupported field ${key}`,
      });
    }
  }
  if (botDoc.formatVersion !== FORMAT_VERSION) {
    errors.push({
      file: FILE_BOT_YAML,
      field: "formatVersion",
      message: `must be ${FORMAT_VERSION}`,
    });
  }

  const name = requiredString(botDoc.name, "name", 100, sink, FILE_BOT_YAML);
  const description = requiredString(
    botDoc.description,
    "description",
    1000,
    sink,
    FILE_BOT_YAML,
  );
  let botPrompt;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(instructionsBytes);
    if (!text.trim()) {
      errors.push({ file: FILE_INSTRUCTIONS, field: "", message: "must not be empty" });
    } else if (text.trim().length > 50000) {
      errors.push({ file: FILE_INSTRUCTIONS, field: "", message: "is too long (max 50000 chars)" });
    } else {
      botPrompt = text.trim();
    }
  } catch {
    errors.push({ file: FILE_INSTRUCTIONS, field: "", message: "must be UTF-8 text" });
  }

  const modelRoles = validateModelRoles(botDoc.modelRoles, sink, FILE_BOT_YAML);
  // Builtins are always on, so the default role always requires tool support.
  for (const role of modelRoles) {
    if (role.role === "default") role.requirements.tools = true;
  }
  const workspace = validateWorkspaceMounts(botDoc.workspace, sink, FILE_BOT_YAML);
  const triggers = validateTriggerDefinitions(botDoc.triggers, sink, FILE_BOT_YAML);
  const githubActions = validateGithubActions(botDoc.githubActions, sink, FILE_BOT_YAML);
  const connectors = validateConnectors(botDoc.connectors, sink, FILE_BOT_YAML);

  for (const trigger of triggers) {
    if (
      trigger.deciderRole !== undefined &&
      !modelRoles.some((role) => role.role === trigger.deciderRole)
    ) {
      errors.push({
        file: FILE_BOT_YAML,
        field: `triggers.${trigger.id}.deciderRole`,
        message: "must be one of the bot's declared model roles",
      });
    }
  }
  if (githubActions.length > 0 && workspace.length === 0) {
    errors.push({
      file: FILE_BOT_YAML,
      field: "githubActions",
      message: "require at least one declared workspace mount",
    });
  }

  // --- knowledge ---
  const knowledge = [];
  const assets = [];
  const knowledgeFiles = [];
  const knowledgeIds = {};
  for (const [path, bytes] of files) {
    if (!path.startsWith(DIR_KNOWLEDGE) || path === KNOWLEDGE_INDEX) continue;
    if (isSkipped(path)) continue;
    const rel = path.slice(DIR_KNOWLEDGE.length);
    knowledgeFiles.push(rel);
    const id = knowledgeIdFor(rel);
    if (knowledgeIds[id]) {
      errors.push({ file: path, field: "", message: `collides with another knowledge id ${id}` });
      continue;
    }
    knowledgeIds[id] = true;
    if (rel.length > 200) {
      errors.push({ file: path, field: "", message: "path is too long (max 200 chars)" });
      continue;
    }
    const text = asInlineText(bytes);
    if (text !== null && text.length <= MAX_TEXT_KNOWLEDGE_BYTES) {
      knowledge.push({ id, name: baseName(rel), kind: "file", content: text });
    } else if (bytes.length > MAX_ASSET_BYTES) {
      errors.push({
        file: path,
        field: "",
        message: `exceeds the ${MAX_ASSET_BYTES} byte per-file limit`,
      });
    } else {
      knowledge.push({ id, name: baseName(rel), kind: "file" });
      assets.push({
        knowledgeId: id,
        path: rel,
        bytes,
        sha256: sha256Hex(bytes),
        size: bytes.length,
        mime: mimeFor(rel),
      });
    }
  }
  // Structured external references (resource/repo kinds). README links stay
  // documentation-only; only these entries become draft knowledge.
  const knowledgeSources = validateKnowledgeSources(botDoc.knowledgeSources, sink, FILE_BOT_YAML);
  for (const item of knowledgeSources) {
    if (knowledgeIds[item.id]) {
      errors.push({ file: FILE_BOT_YAML, field: `knowledgeSources.${item.id}`, message: `contains duplicate knowledge id ${item.id}` });
      continue;
    }
    knowledgeIds[item.id] = true;
    knowledge.push(item);
  }
  if (knowledge.length > 100) {
    errors.push({ file: DIR_KNOWLEDGE, field: "", message: "has too many entries (max 100)" });
  }

  // --- skills (local + vendored externals) ---
  const skills = [];
  const skillFiles = [];
  const skillIds = {};
  const skillDirs = [];
  /**
   * @param {string} skillId
   * @param {string} skillRoot prefix within files, e.g. skills/demo/
   * @param {string} blamePath file blamed for validation errors
   */
  const ingestSkillDir = (skillId, skillRoot, blamePath) => {
    if (skillIds[skillId]) {
      errors.push({ file: blamePath, field: "", message: `contains duplicate skill id ${skillId}` });
      return;
    }
    skillIds[skillId] = true;
    const skillDocPath = skillRoot + "SKILL.md";
    const skillBytes = files.get(skillDocPath);
    if (skillBytes === undefined) {
      errors.push({ file: blamePath, field: "", message: "has no SKILL.md" });
      return;
    }
    let skillText;
    try {
      skillText = new TextDecoder("utf-8", { fatal: true }).decode(skillBytes);
    } catch {
      errors.push({ file: skillDocPath, field: "", message: "must be UTF-8 text" });
      return;
    }
    // Platform requires non-empty skill content: reject here so an empty
    // SKILL.md can never pass local validation yet fail ingest.
    if (!skillText.trim()) {
      errors.push({ file: skillDocPath, field: "", message: "must not be empty" });
      return;
    }
    if (new TextEncoder().encode(skillText).length > MAX_SKILL_BYTES) {
      errors.push({
        file: skillDocPath,
        field: "",
        message: `exceeds the ${MAX_SKILL_BYTES} byte skill limit`,
      });
      return;
    }
    const frontmatter = parseSkillFrontmatter(skillText);
    const skillName =
      (typeof frontmatter.name === "string" && frontmatter.name.trim()) ||
      firstHeading(skillText) ||
      skillId;
    const description =
      (typeof frontmatter.description === "string" && frontmatter.description.trim()) || "";
    if (skillName.length > 200) {
      errors.push({ file: skillDocPath, field: "name", message: "is too long (max 200 chars)" });
      return;
    }
    if (description.length > 1000) {
      errors.push({ file: skillDocPath, field: "description", message: "is too long (max 1000 chars)" });
      return;
    }
    skills.push({ id: skillId, name: skillName, description, content: skillText });
    // Supporting files travel with the skill so the runtime materializes
    // the full skill directory, not just SKILL.md content.
    let count = 0;
    for (const [path, bytes] of files) {
      if (!path.startsWith(skillRoot) || path === skillDocPath) continue;
      if (isSkipped(path)) continue;
      count++;
      if (count > MAX_SKILL_FILES) {
        errors.push({ file: skillRoot, field: "", message: `has too many supporting files (max ${MAX_SKILL_FILES})` });
        return;
      }
      if (bytes.length > MAX_SKILL_FILE_BYTES) {
        errors.push({ file: path, field: "", message: `exceeds the ${MAX_SKILL_FILE_BYTES} byte skill-file limit` });
        continue;
      }
      skillFiles.push({
        skillId,
        path: path.slice(skillRoot.length),
        bytes,
        sha256: sha256Hex(bytes),
        size: bytes.length,
      });
    }
  };

  for (const [path] of files) {
    if (!path.startsWith(DIR_SKILLS) || path.startsWith(DIR_VENDOR)) continue;
    if (isSkipped(path)) continue;
    const rest = path.slice(DIR_SKILLS.length);
    if (rest === "sources.yaml" || rest === "sources.lock") continue;
    const slash = rest.indexOf("/");
    if (slash < 0) {
      if (rest === "README.md") continue;
      errors.push({
        file: path,
        field: "",
        message: "skills/ holds skill directories (with SKILL.md), sources.yaml, or README.md",
      });
      continue;
    }
    const dirName = rest.slice(0, slash);
    if (dirName === ".vendor") continue;
    const id = entryId(dirName, `skills/${dirName}`, sink, FILE_BOT_YAML);
    if (id === undefined) continue;
    if (skillDirs.includes(dirName)) continue;
    skillDirs.push(dirName);
    if (rest === `${dirName}/SKILL.md`) {
      ingestSkillDir(id, `${DIR_SKILLS}${dirName}/`, path);
    }
  }
  // Directories seen but without SKILL.md at depth 1 still error loudly.
  for (const dirName of skillDirs) {
    if (!skills.some((s) => s.id === dirName) && !skillIds[dirName]) {
      ingestSkillDir(dirName, `${DIR_SKILLS}${dirName}/`, `${DIR_SKILLS}${dirName}/`);
    }
  }

  // --- external skill sources (lock + vendored content) ---
  let lock = null;
  const sourcesDoc = readYamlFile(files, FILE_SOURCES, sink);
  const lockDoc = readYamlFile(files, FILE_LOCK, sink);
  if (sourcesDoc !== undefined || lockDoc !== undefined) {
    const parsed = parseSourcesYaml(sourcesDoc, sink);
    if (lockDoc === null || lockDoc === undefined) {
      if (parsed) {
        errors.push({
          file: FILE_LOCK,
          field: "",
          message: "is required when skills/sources.yaml exists: run `librebot resolve-skills --vendor`",
        });
      }
    } else if (parsed) {
      lock = checkSourcesLock(parsed, lockDoc, sink);
      if (lock) {
        const vendorDirs = [];
        const ingestVendorRoot = (entry, root, skill) => {
          const skillId = ("ext-" + entry.name + "-" + skill).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
          ingestSkillDir(skillId, root, root + "SKILL.md");
          vendorDirs.push(root);
        };
        for (const entry of lock.resolved) {
          if (entry.contentSha256 && vendorContentHash(Object.fromEntries(files), `${DIR_VENDOR}${entry.name}/`) !== entry.contentSha256) {
            errors.push({ file: FILE_LOCK, field: entry.name, message: "vendored content does not match its locked digest; restore it or run resolve-skills --update --network --vendor" });
            continue;
          }
          if (entry.skills.length > 0) {
            // Explicit selection: exact vendored subtrees only.
            for (const skill of entry.skills) {
              const roots = [
                `${DIR_VENDOR}${entry.name}/${skill}/`,
                `${DIR_VENDOR}${entry.name}/`,
              ];
              const root = roots.find((r) => files.get(r + "SKILL.md") !== undefined);
              if (root === undefined) {
                errors.push({
                  file: FILE_LOCK,
                  field: entry.name,
                  message: `locked skill ${skill} is not vendored: run \`librebot resolve-skills --vendor\``,
                });
                continue;
              }
              ingestVendorRoot(entry, root, skill);
            }
            continue;
          }
          // Default selection: discover the same roots the vendor step
          // writes — immediate subdirectories holding SKILL.md, or the
          // source root itself for dedicated single-skill repos.
          const prefix = `${DIR_VENDOR}${entry.name}/`;
          if (files.get(prefix + "SKILL.md") !== undefined) {
            ingestVendorRoot(entry, prefix, entry.name);
            continue;
          }
          const discovered = new Set();
          for (const [path] of files) {
            if (!path.startsWith(prefix) || !path.endsWith("/SKILL.md")) continue;
            const rest = path.slice(prefix.length, -"SKILL.md".length);
            if (rest.endsWith("/") && !rest.slice(0, -1).includes("/")) {
              discovered.add(rest);
            }
          }
          if (discovered.size === 0) {
            errors.push({
              file: FILE_LOCK,
              field: entry.name,
              message: `locked source has no vendored skills: run \`librebot resolve-skills --vendor\``,
            });
            continue;
          }
          for (const root of [...discovered].sort()) {
            ingestVendorRoot(entry, prefix + root, root.slice(0, -1));
          }
        }
        lock.vendorDirs = vendorDirs;
      }
    }
  }
  if (skills.length > 100) {
    errors.push({ file: DIR_SKILLS, field: "", message: "has too many entries (max 100)" });
  }

  if (errors.length > 0 || name === undefined || description === undefined || botPrompt === undefined) {
    return { ok: false, errors, warnings };
  }
  const draft = {
    name,
    description,
    botPrompt,
    modelRoles,
    knowledge,
    skills,
    connectors,
    triggers,
    workspace,
    githubActions,
  };
  // Byte length (UTF-8), exactly like the platform: char counts would let
  // multibyte-heavy drafts pass locally then fail the 750 KB ingest cap.
  if (new TextEncoder().encode(JSON.stringify(draft)).length > MAX_DRAFT_BYTES) {
    return {
      ok: false,
      errors: [
        ...errors,
        { file: FILE_BOT_YAML, field: "", message: "bot definition exceeds the 750 KB limit" },
      ],
      warnings,
    };
  }
  return {
    ok: true,
    errors,
    warnings,
    formatVersion: FORMAT_VERSION,
    draft,
    assets,
    skillFiles,
    source: {
      botYaml: FILE_BOT_YAML,
      instructions: FILE_INSTRUCTIONS,
      knowledgeFiles,
      skillDirs,
      lockPresent: lockDoc !== undefined,
      sourcesPresent: sourcesDoc !== undefined,
    },
    lock,
  };
}

// --- filesystem wrappers (local dev + server-side extracted trees) ---

/**
 * Read a directory recursively into a posix-relative file map.
 * Skips dotfile segments (except under skills/.vendor/) and node_modules.
 * Symlinks and special files throw: they must fail loudly, never parse as
 * a silently different tree than server-side ingestion sees.
 */
export async function readDirFiles(dir) {
  /** @type {Record<string, Uint8Array>} */
  const files = {};
  async function walk(relative) {
    const entries = await readdir(join(dir, relative), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (rel === "node_modules" || rel.startsWith("node_modules/")) continue;
      if (rel !== "skills/.vendor" && !rel.startsWith("skills/.vendor/") && rel.split("/").some((s) => s.startsWith("."))) {
        continue;
      }
      // Symlinks and special files are rejected loudly, never silently
      // omitted: a tree that parses locally must ingest identically
      // server-side, where Git tree modes reject mode120000 blobs.
      if (entry.isSymbolicLink()) {
        throw new Error(`symlinks are not supported: ${rel}`);
      }
      if (entry.isDirectory()) {
        await walk(rel);
      } else if (entry.isFile()) {
        files[rel] = await readFile(join(dir, rel));
      } else {
        throw new Error(`unsupported file type: ${rel}`);
      }
    }
  }
  await walk("");
  return files;
}

/**
 * Validate a bot source directory. NEVER throws on invalid source: returns
 * `{ ok, errors, warnings, ... }`. Only filesystem failures throw.
 * - ok true: `{ ok: true, errors: [], warnings, formatVersion, draft,
 *   assets, skillFiles, source, lock }`
 * - ok false: `{ ok: false, errors: [{ file, field, message }], warnings }`
 * `bytes` fields are Uint8Arrays; use preview stripping for JSON output.
 */
export async function validateSource(dir) {
  return validateFiles(await readDirFiles(dir));
}

/**
 * Parse a bot source directory. Throws BotSourceError (carrying
 * `.errors[]`/`warnings[]`) on invalid source; filesystem failures throw
 * natively. Returns `{ formatVersion, draft, assets, skillFiles, warnings,
 * source, lock }`.
 */
export async function parseBotSource(dir) {
  return parseBotFiles(await readDirFiles(dir));
}

