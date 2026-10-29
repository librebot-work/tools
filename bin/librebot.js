#!/usr/bin/env node
// librebot CLI: validate, preview, scaffold, resolve-skills.

import { parseArgs } from "node:util";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  readDirFiles,
  scaffoldBot,
  validateSource,
} from "../src/index.js";
import {
  parseSourcesText,
  parseSourcesYaml,
  resolveSkillsLock,
  serializeLock,
} from "../src/skills-lock.js";
import { toBytes } from "../src/util.js";

function fail(message, issues) {
  console.error(`error: ${message}`);
  for (const issue of issues ?? []) {
    console.error(`  ${issue.file || "."}:${issue.field || "-"}: ${issue.message}`);
  }
  process.exit(1);
}

function printWarnings(warnings, json) {
  if (json) return;
  for (const warning of warnings) {
    console.error(
      `warning: ${warning.file || "."}:${warning.field || "-"}: ${warning.message}`,
    );
  }
}

/** Draft/assets summary with bytes replaced by hashes (JSON-safe). */
function previewShape(result) {
  return {
    formatVersion: result.formatVersion,
    draft: {
      ...result.draft,
      knowledge: result.draft.knowledge.map((k) => ({
        ...k,
        ...(k.content !== undefined ? { contentChars: k.content.length, content: undefined } : {}),
      })),
      skills: result.draft.skills.map((s) => ({
        ...s,
        contentChars: s.content.length,
        content: undefined,
      })),
    },
    assets: result.assets.map((a) => ({
      knowledgeId: a.knowledgeId,
      path: a.path,
      sha256: a.sha256,
      size: a.size,
      mime: a.mime,
    })),
    skillFiles: result.skillFiles.map((f) => ({
      skillId: f.skillId,
      path: f.path,
      sha256: f.sha256,
      size: f.size,
    })),
    warnings: result.warnings,
    source: result.source,
    lock: result.lock,
  };
}

async function cmdValidate(dir, json) {
  const result = await validateSource(dir).catch((error) =>
    fail(`could not read ${dir}: ${error.message}`),
  );
  printWarnings(result.warnings, json);
  if (!result.ok) {
    if (json) {
      console.log(JSON.stringify({ ok: false, errors: result.errors, warnings: result.warnings }, null, 2));
      process.exit(1);
    }
    fail("invalid bot source", result.errors);
  }
  if (json) {
    console.log(JSON.stringify({ ok: true, warnings: result.warnings }, null, 2));
  } else {
    console.log(
      `valid: ${result.draft.name} (${result.draft.knowledge.length} knowledge, ` +
        `${result.draft.skills.length} skills, ${result.assets.length} assets, ` +
        `${result.skillFiles.length} skill files)`,
    );
  }
}

async function cmdPreview(dir, json) {
  const result = await validateSource(dir).catch((error) =>
    fail(`could not read ${dir}: ${error.message}`),
  );
  if (!result.ok) fail("invalid bot source", result.errors);
  const shape = previewShape(result);
  if (json) {
    console.log(JSON.stringify(shape, null, 2));
    return;
  }
  const { draft } = result;
  console.log(`# ${draft.name} (${draft.visibility})`);
  console.log(`${draft.description}\n`);
  console.log(`prompt: instructions.md (${draft.botPrompt.length} chars)`);
  console.log(`roles: ${draft.modelRoles.map((r) => r.role).join(", ")}`);
  console.log(`knowledge (${draft.knowledge.length}):`);
  for (const item of draft.knowledge) {
    const asset = result.assets.find((a) => a.knowledgeId === item.id);
    console.log(
      `  - ${item.name} [${item.id}]` +
        (asset ? ` asset ${asset.mime} ${asset.size}B sha256:${asset.sha256.slice(0, 12)}` : item.url ? ` ${item.kind} ${item.url}` : ` inline ${item.content.length} chars`),
    );
  }
  console.log(`skills (${draft.skills.length}):`);
  for (const skill of draft.skills) {
    const extras = result.skillFiles.filter((f) => f.skillId === skill.id).length;
    console.log(`  - ${skill.name} [${skill.id}]${extras > 0 ? ` +${extras} files` : ""}`);
  }
  if (draft.connectors.length > 0) {
    console.log(`connectors (${draft.connectors.length}):`);
    for (const conn of draft.connectors) {
      console.log(`  - ${conn.label} [${conn.id}]${conn.endpoint ? ` -> ${conn.endpoint}` : ""}`);
    }
  }
  if (draft.triggers.length > 0) {
    console.log(`triggers: ${draft.triggers.map((t) => t.id).join(", ")}`);
  }
  if (draft.workspace.length > 0) {
    console.log(`workspace: ${draft.workspace.map((w) => `${w.id}=${w.path}`).join(", ")}`);
  }
  if (draft.githubActions.length > 0) {
    console.log(`githubActions: ${draft.githubActions.join(", ")}`);
  }
  if (result.lock) {
    console.log(`skill lock: ${result.lock.resolved.length} sources pinned`);
  }
  printWarnings(result.warnings, false);
}

async function cmdScaffold(dir, options) {
  const name = options.name;
  if (!name) fail("scaffold requires --name");
  try {
    const written = await scaffoldBot(
      dir,
      { name, description: options.description ?? "", visibility: options.visibility },
      { force: options.force === true },
    );
    if (!options.json) {
      console.log(`scaffolded ${written.length} files in ${dir}`);
    } else {
      console.log(JSON.stringify({ dir, written }, null, 2));
    }
  } catch (error) {
    fail(error.message);
  }
}

async function cmdResolveSkills(dir, options) {
  const files = await readDirFiles(dir).catch((error) =>
    fail(`could not read ${dir}: ${error.message}`),
  );
  const raw = files["skills/sources.yaml"];
  if (raw === undefined) fail("no skills/sources.yaml in " + dir);
  const sink = { errors: [], warnings: [] };
  const parsed = parseSourcesYaml(parseSourcesText(new TextDecoder().decode(raw)), sink);
  if (!parsed) fail("invalid skills/sources.yaml", sink.errors);
  let existingLock;
  const lockRaw = files["skills/sources.lock"];
  if (lockRaw !== undefined && !options.update) {
    try {
      const { checkSourcesLock } = await import("../src/skills-lock.js");
      const lockSink = { errors: [], warnings: [] };
      existingLock = checkSourcesLock(
        parsed,
        parseSourcesText(new TextDecoder().decode(lockRaw)),
        lockSink,
      ) ?? undefined;
    } catch {
      existingLock = undefined;
    }
  }
  const { lock, vendorFiles, errors, warnings } = await resolveSkillsLock({
    sources: parsed,
    existingLock,
    update: options.update === true,
    network: options.network === true,
    vendor: options.vendor === true,
    sourceBaseDir: dir,
    currentFiles: files,
  });
  for (const warning of [...sink.warnings, ...warnings]) {
    if (!options.json) {
      console.error(`warning: ${warning.file}:${warning.field}: ${warning.message}`);
    }
  }
  if (errors.length > 0) fail("could not resolve skill sources", errors);
  await writeFile(join(dir, "skills/sources.lock"), serializeLock(lock));
  if (options.vendor) {
    await rm(join(dir, "skills", ".vendor"), { recursive: true, force: true });
    for (const [rel, bytes] of Object.entries(vendorFiles)) {
      await mkdir(join(dir, rel.split("/").slice(0, -1).join("/")), { recursive: true });
      await writeFile(join(dir, rel), toBytes(bytes));
    }
  }
  const shape = {
    lock: join(dir, "skills/sources.lock"),
    sources: lock.resolved.length,
    vendored: Object.keys(vendorFiles).length,
  };
  if (options.json) {
    console.log(JSON.stringify(shape, null, 2));
  } else {
    console.log(
      `locked ${shape.sources} sources -> ${shape.lock}` +
        (options.vendor ? ` (${shape.vendored} vendored files)` : ""),
    );
  }
}

const [command, dir] = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    json: { type: "boolean", default: false },
    name: { type: "string" },
    description: { type: "string" },
    visibility: { type: "string" },
    force: { type: "boolean", default: false },
    update: { type: "boolean", default: false },
    vendor: { type: "boolean", default: false },
    network: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

if (command === "validate") {
  if (!dir) fail("usage: librebot validate <dir> [--json]");
  await cmdValidate(dir, values.json);
} else if (command === "preview") {
  if (!dir) fail("usage: librebot preview <dir> [--json]");
  await cmdPreview(dir, values.json);
} else if (command === "scaffold") {
  if (!dir) fail("usage: librebot scaffold <dir> --name <name> [--description ...] [--visibility public|private] [--force]");
  if (values.visibility !== undefined && values.visibility !== "public" && values.visibility !== "private") {
    fail("visibility must be public or private");
  }
  await cmdScaffold(dir, values);
} else if (command === "resolve-skills") {
  if (!dir) fail("usage: librebot resolve-skills <dir> [--update] [--vendor] [--network]");
  await cmdResolveSkills(dir, values);
} else {
  console.error("usage: librebot <validate|preview|scaffold|resolve-skills> <dir> [options]");
  process.exit(1);
}

