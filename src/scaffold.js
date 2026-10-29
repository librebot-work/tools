// Scaffold (new bot skeleton) and export (BotDraft -> source tree) helpers.
// Both return in-memory maps; the `*Bot` fs variants write them to disk.

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { toBytes } from "./util.js";


function skeletonInstructions(name) {
  return `# ${name}\n\nDescribe what this bot does, how it should behave, and any\npolicies it must follow. This file becomes the bot's main prompt.\n`;
}

function skeletonKnowledgeReadme(name) {
  return `# Knowledge\n\nFiles in this directory are the bot's knowledge assets. Any file format\nis accepted in source; large or binary files travel as content-addressed\nassets alongside the parsed definition.\n\n- \`product-guide.md\` — sample knowledge document for ${name}.\n`;
}

function skeletonSkill() {
  return `---\nname: demo\ndescription: Sample skill demonstrating the SKILL.md convention.\n---\n\n# Demo skill\n\nInstructions the bot follows when this skill applies.\n`;
}

/**
 * Build a new-bot skeleton file map.
 * @param {{ name: string; description?: string; visibility?: "public"|"private" }} input
 * @returns {Record<string, string>}
 */
export function scaffoldBotFiles(input) {
  const name = String(input?.name ?? "").trim();
  if (!name || name.length > 100) {
    throw new Error("scaffold requires a name of 1-100 chars");
  }
  const visibility = input.visibility === "public" ? "public" : "private";
  const description = String(input?.description ?? "").trim() || `Bot named ${name}.`;
  const botYaml = {
    formatVersion: 1,
    name,
    description,
    visibility,
    modelRoles: [{ role: "default", label: "Main" }],
    workspace: [],
    triggers: [],
    githubActions: [],
    connectors: [],
  };
  return {
    "bot.yaml": stringifyYaml(botYaml),
    "instructions.md": skeletonInstructions(name),
    "knowledge/README.md": skeletonKnowledgeReadme(name),
    "knowledge/product-guide.md": `# Product guide\n\nReplace this sample with real knowledge for ${name}.\n`,
    "skills/demo/SKILL.md": skeletonSkill(),
  };
}

/**
 * Export a parsed draft back to a source tree. Inline knowledge/skill
 * content round-trips; binary knowledge needs its `assets` entry and skill
 * supporting files need `skillFiles` (same shapes parseBotFiles returns).
 * Resource/repo knowledge (url, no content) round-trips through
 * bot.yaml `knowledgeSources`. Vendor grouping is flattened to
 * skills/<id>/: re-running resolve-skills restores pins while content
 * bytes stay identical.
 *
 * Filenames are derived from the stable entry id (sanitized), never the
 * display name: legacy names may contain separators or traversal, and only
 * ids are guaranteed unique. Asset paths tolerate a redundant `knowledge/`
 * prefix (never doubled) and are segment-sanitized.
 */
export function exportBotFiles(
  draft,
  { assets = [], skillFiles = [], sourcesText, lockText } = {},
) {
  if (typeof draft !== "object" || draft === null) {
    throw new Error("export requires a draft object");
  }
  const {
    name,
    description,
    visibility,
    botPrompt,
    modelRoles,
    workspace,
    triggers,
    githubActions,
    connectors,
  } = draft;
  if (typeof name !== "string" || typeof botPrompt !== "string") {
    throw new Error("export requires at least draft name and botPrompt");
  }
  /** @type {Record<string, string|Uint8Array>} */
  const files = {};
  const usedPaths = new Set();
  const claimPath = (wanted) => {
    let candidate = wanted;
    let counter = 2;
    while (usedPaths.has(candidate)) {
      const dot = wanted.lastIndexOf(".");
      candidate = dot > 0 ? `${wanted.slice(0, dot)}__${counter}${wanted.slice(dot)}` : `${wanted}__${counter}`;
      counter++;
    }
    usedPaths.add(candidate);
    return candidate;
  };
  const knowledgeSources = [];
  const assetById = new Map((assets ?? []).map((a) => [a.knowledgeId, a]));
  for (const item of draft.knowledge ?? []) {
    if (typeof item.url === "string" && item.url) {
      // External reference: structured source entry, never a file.
      const source = { id: item.id, name: item.name, kind: item.kind, url: item.url };
      if (item.ref !== undefined) source.ref = item.ref;
      knowledgeSources.push(source);
      continue;
    }
    if (typeof item.content === "string") {
      files[claimPath(`knowledge/${exportKnowledgeFilename(item)}`)] = item.content;
    } else {
      const asset = assetById.get(item.id);
      if (!asset) {
        throw new Error(`knowledge ${item.id} has no content and no asset bytes`);
      }
      files[claimPath(`knowledge/${sanitizeAssetRel(asset.path)}`)] = asset.bytes;
    }
  }
  files["bot.yaml"] = stringifyYaml({
    formatVersion: 1,
    name,
    description: description ?? "",
    visibility: visibility ?? "private",
    modelRoles: modelRoles ?? [{ role: "default", label: "Main" }],
    workspace: workspace ?? [],
    triggers: triggers ?? [],
    githubActions: githubActions ?? [],
    connectors: connectors ?? [],
    knowledgeSources,
  });
  files["instructions.md"] = botPrompt;
  files["knowledge/README.md"] =
    "# Knowledge\n\nFiles in this directory are the bot's knowledge assets.\n";
  const skillExtras = new Map();
  for (const file of skillFiles ?? []) {
    if (!skillExtras.has(file.skillId)) skillExtras.set(file.skillId, []);
    skillExtras.get(file.skillId).push(file);
  }
  for (const skill of draft.skills ?? []) {
    const skillId = sanitizePathSegment(skill.id, "skill");
    files[`skills/${skillId}/SKILL.md`] = withSkillFrontmatter(skill);
    for (const extra of skillExtras.get(skill.id) ?? []) {
      files[`skills/${skillId}/${sanitizeAssetRel(extra.path)}`] = extra.bytes;
    }
  }
  if (sourcesText !== undefined) files["skills/sources.yaml"] = sourcesText;
  if (lockText !== undefined) files["skills/sources.lock"] = lockText;
  return files;
}

/** Stable export filename from the entry id; the display name only lends an extension. */
export function exportKnowledgeFilename(item) {
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(String(item.name ?? ""));
  const id = sanitizePathSegment(item.id, "knowledge");
  const suffix = ext ? `.${ext[1].toLowerCase()}` : "";
  return id.toLowerCase().endsWith(suffix) ? id : id + suffix;
}

/** Sanitize one path segment: no traversal, no separators, non-empty. */
export function sanitizePathSegment(segment, what) {
  let clean = String(segment ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  if (!/^[A-Za-z0-9]/.test(clean)) clean = `${what}_` + clean;
  return clean.slice(0, 64) || `${what}_file`;
}

/**
 * Sanitize a multi-segment relative path. A redundant leading `knowledge/`
 * prefix is stripped (never doubled); `..`/empty segments are neutralized
 * by per-segment sanitizing, so the result always stays in place.
 */
export function sanitizeAssetRel(rel) {
  const segments = String(rel ?? "").replace(/\\/g, "/").split("/");
  if (segments[0] === "knowledge") segments.shift();
  const clean = segments.map((s) => sanitizePathSegment(s, "file")).filter(Boolean);
  return clean.length > 0 ? clean.join("/") : "file";
}

/**
 * Ensure SKILL.md content carries frontmatter so name/description survive a
 * re-parse round-trip. Legacy skill content without a frontmatter block
 * gets one injected from the draft fields (JSON-quoted: valid YAML).
 */
export function withSkillFrontmatter(skill) {
  const content = String(skill.content ?? "");
  if (/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/.test(content)) return content;
  const name = JSON.stringify(String(skill.name ?? skill.id));
  const description = JSON.stringify(String(skill.description ?? ""));
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}`;
}

/** Write a file map to disk, creating directories as needed. */
export async function writeFiles(dir, files) {
  const paths = Object.keys(files).sort();
  for (const rel of paths) {
    if (rel.includes("..") || rel.startsWith("/") || rel === "") {
      throw new Error(`refusing to write outside the target: ${rel}`);
    }
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    const value = files[rel];
    await writeFile(full, typeof value === "string" ? value : toBytes(value));
  }
  return paths;
}

/**
 * Create a scaffold in `dir`. Refuses non-empty directories unless `force`.
 * @returns {Promise<string[]>} written relative paths
 */
export async function scaffoldBot(dir, input, { force = false } = {}) {
  if (!force) {
    const existing = await readdir(dir).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    if (existing.length > 0) {
      throw new Error(`directory is not empty (use force to overwrite): ${dir}`);
    }
  }
  return writeFiles(dir, scaffoldBotFiles(input));
}
