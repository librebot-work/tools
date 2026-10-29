// Semantic validation mirroring the platform catalog validators
// (services/shared: catalog-validation, workspace, trigger-types,
// repository). bot.yaml shape errors use file "bot.yaml"; cross-file and
// platform-parity limits live here so local `validate`, server ingestion,
// and UI saves share one rule set. `tools` is intentionally absent: builtin
// tools are always on (runtime behavior, no contract field).

import { isRecord } from "./errors.js";
import { sha256Hex } from "./util.js";

export const FORMAT_VERSION = 1;
export const MODEL_ROLES = ["default", "smol", "slow", "plan"];
export const GITHUB_ACTIONS = [
  "read_issue",
  "push_branch",
  "pull_request",
  "comment_issue",
];
export const TRIGGER_KIND_GITHUB = "github";

const ENTRY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const INPUT_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const REPO_FULL_NAME_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const MOUNT_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EVENT_TYPE_RE = /^[A-Za-z0-9._-]+$/;
const REF_RE = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;
const RESERVED_TOP = {
  ".git": true,
  ".librebot": true,
  ".omp": true,
  ".config": true,
  ".ssh": true,
};

/**
 * @typedef {{ file: string; field: string; message: string }} SourceIssue
 * @typedef {{ errors: SourceIssue[]; warnings: SourceIssue[] }} IssueSink
 */

function err(sink, file, field, message) {
  sink.errors.push({ file, field, message });
}

function warn(sink, file, field, message) {
  sink.warnings.push({ file, field, message });
}

function requiredString(value, field, max, sink, file) {
  if (typeof value !== "string" || !value.trim()) {
    err(sink, file, field, "is required");
    return undefined;
  }
  if (value.trim().length > max) {
    err(sink, file, field, `is too long (max ${max} chars)`);
    return undefined;
  }
  return value.trim();
}

function optionalString(value, field, max, sink, file) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    err(sink, file, field, "must be a string");
    return undefined;
  }
  if (value.trim().length > max) {
    err(sink, file, field, `is too long (max ${max} chars)`);
    return undefined;
  }
  return value.trim();
}

function optionalText(value, field, max, sink, file) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    err(sink, file, field, "must be a non-empty string");
    return undefined;
  }
  if (value.trim().length > max) {
    err(sink, file, field, `is too long (max ${max} chars)`);
    return undefined;
  }
  return value.trim();
}

function optionalUrl(value, field, sink, file) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length > 500) {
    err(sink, file, field, "must be a URL string up to 500 chars");
    return undefined;
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    err(sink, file, field, "must be a valid URL");
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    err(sink, file, field, "must be an http(s) URL");
    return undefined;
  }
  return value.trim();
}

function entryId(value, field, sink, file) {
  if (typeof value !== "string" || !ENTRY_ID_RE.test(value.trim())) {
    err(sink, file, field, "has an invalid id");
    return undefined;
  }
  return value.trim();
}

function checkKeys(value, allowed, field, sink, file) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      err(sink, file, field, `contains unsupported field ${key}`);
    }
  }
}

/** https-only repository URL without credentials or local hosts. */
export function validateRepositoryUrl(raw, field, sink, file) {
  const url = (raw ?? "").trim();
  if (!url) {
    err(sink, file, field, "is required");
    return undefined;
  }
  if (url.length > 2048) {
    err(sink, file, field, "is too long");
    return undefined;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    err(sink, file, field, "must be a valid https URL");
    return undefined;
  }
  if (parsed.protocol !== "https:") {
    err(sink, file, field, "must use https");
    return undefined;
  }
  if (parsed.username || parsed.password) {
    err(sink, file, field, "must not embed credentials");
    return undefined;
  }
  if (!parsed.hostname) {
    err(sink, file, field, "must include a host");
    return undefined;
  }
  if (
    parsed.hostname === "localhost" ||
    parsed.hostname.startsWith("127.") ||
    parsed.hostname === "::1"
  ) {
    err(sink, file, field, "must not target local hosts");
    return undefined;
  }
  return parsed.toString();
}

function validateRef(raw, field, sink, file) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") {
    err(sink, file, field, "must be a string");
    return undefined;
  }
  const ref = raw.trim();
  if (!ref || ref.length > 256 || !REF_RE.test(ref) || ref.includes("..")) {
    err(sink, file, field, "is invalid");
    return undefined;
  }
  return ref;
}

function stringList(value, field, sink, file) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    err(sink, file, field, "must be an array of at most 100 strings");
    return [];
  }
  const out = [];
  value.forEach((entry, i) => {
    const s = requiredString(entry, `${field}[${i}]`, 200, sink, file);
    if (s !== undefined) out.push(s);
  });
  return out;
}

export function validateModelRoles(input, sink, file) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 4) {
    err(sink, file, "modelRoles", "must declare 1-4 roles including default");
    return [];
  }
  const seen = {};
  const roles = [];
  input.forEach((entry, i) => {
    const field = `modelRoles[${i}]`;
    if (!isRecord(entry)) {
      err(sink, file, field, "must be an object");
      return;
    }
    checkKeys(entry, ["role", "label", "requirements"], field, sink, file);
    if (typeof entry.role !== "string" || !MODEL_ROLES.includes(entry.role)) {
      err(sink, file, `${field}.role`, "must be one of default, smol, slow, plan");
      return;
    }
    if (seen[entry.role]) {
      err(sink, file, field, `contains duplicate role ${entry.role}`);
      return;
    }
    seen[entry.role] = true;
    const label = requiredString(entry.label, `${field}.label`, 100, sink, file);
    if (label === undefined) return;
    const requirements = validateRequirements(entry.requirements, `${field}.requirements`, sink, file);
    if (requirements === undefined) return;
    roles.push({ role: entry.role, label, requirements });
  });
  if (!seen["default"]) {
    err(sink, file, "modelRoles", "must declare a default role");
  }
  return roles;
}

/**
 * Model capability requirements. Passed through (validated) so bot.yaml
 * preserves the full platform ModelRequirements contract: tools, vision,
 * reasoning, and minContextWindow.
 */
export function validateRequirements(input, field, sink, file) {
  if (input === undefined) return {};
  if (!isRecord(input)) {
    err(sink, file, field, "must be an object");
    return undefined;
  }
  checkKeys(input, ["tools", "vision", "reasoning", "minContextWindow"], field, sink, file);
  const out = {};
  for (const key of ["tools", "vision", "reasoning"]) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean") {
        err(sink, file, `${field}.${key}`, "must be a boolean");
        return undefined;
      }
      if (input[key]) out[key] = true;
    }
  }
  if (input.minContextWindow !== undefined) {
    if (typeof input.minContextWindow !== "number" || !Number.isFinite(input.minContextWindow) || input.minContextWindow <= 0) {
      err(sink, file, `${field}.minContextWindow`, "must be a positive number");
      return undefined;
    }
    out.minContextWindow = input.minContextWindow;
  }
  return out;
}

/**
 * Structured external knowledge references (BotKnowledge resource/repo
 * kinds). Human-readable links in knowledge/README.md stay documentation
 * only; only these entries become draft knowledge. File-backed knowledge
 * comes from the knowledge/ tree.
 */
export function validateKnowledgeSources(input, sink, file) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    err(sink, file, "knowledgeSources", "must be an array");
    return [];
  }
  if (input.length > 100) {
    err(sink, file, "knowledgeSources", "has too many entries");
    return [];
  }
  const ids = {};
  const out = [];
  input.forEach((entry, i) => {
    const field = `knowledgeSources[${i}]`;
    if (!isRecord(entry)) {
      err(sink, file, field, "must be an object");
      return;
    }
    checkKeys(entry, ["id", "name", "kind", "url", "ref"], field, sink, file);
    const id = entryId(entry.id, field, sink, file);
    if (id === undefined) return;
    if (ids[id]) {
      err(sink, file, field, `contains duplicate id ${id}`);
      return;
    }
    ids[id] = true;
    if (entry.kind !== "resource" && entry.kind !== "repo") {
      err(sink, file, `${field}.kind`, "must be resource or repo");
      return;
    }
    const name = requiredString(entry.name, `${field}.name`, 200, sink, file);
    if (name === undefined) return;
    const url = optionalUrl(entry.url, `${field}.url`, sink, file);
    if (url === undefined) {
      err(sink, file, `${field}.url`, entry.kind === "repo" ? "repo entries require url" : "resource entries require url");
      return;
    }
    const item = { id, name, kind: entry.kind, url };
    if (entry.kind === "repo") {
      const validated = validateRepositoryUrl(url, `${field}.url`, sink, file);
      if (validated === undefined) return;
      item.url = validated;
      const ref = validateRef(entry.ref, `${field}.ref`, sink, file);
      if (ref !== undefined) item.ref = ref;
    }
    out.push(item);
  });
  return out;
}

export function validateConnectors(input, sink, file) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    err(sink, file, "connectors", "must be an array");
    return [];
  }
  if (input.length > 50) {
    err(sink, file, "connectors", "has too many entries");
    return [];
  }
  const ids = {};
  const out = [];
  input.forEach((entry, i) => {
    const field = `connectors[${i}]`;
    if (!isRecord(entry)) {
      err(sink, file, field, "must be an object");
      return;
    }
    checkKeys(
      entry,
      ["id", "label", "description", "required", "tools", "resources", "endpoint"],
      field,
      sink,
      file,
    );
    const id = entryId(entry.id, field, sink, file);
    if (id === undefined) return;
    if (ids[id]) {
      err(sink, file, field, `contains duplicate id ${id}`);
      return;
    }
    ids[id] = true;
    if (entry.required !== undefined && typeof entry.required !== "boolean") {
      err(sink, file, `${field}.required`, "must be a boolean");
      return;
    }
    if (entry.resources !== undefined && !Array.isArray(entry.resources)) {
      err(sink, file, `${field}.resources`, "must be an array");
      return;
    }
    const connectorTools = stringList(entry.tools, `${field}.tools`, sink, file);
    if (connectorTools.length === 0) {
      err(sink, file, field, "must declare at least one tool");
      return;
    }
    const resourceKeys = {};
    const resources = [];
    let resourcesOk = true;
    (Array.isArray(entry.resources) ? entry.resources : []).forEach((res, j) => {
      const rfield = `${field}.resources[${j}]`;
      if (!isRecord(res)) {
        err(sink, file, rfield, "must be an object");
        resourcesOk = false;
        return;
      }
      checkKeys(res, ["key", "label", "tools"], rfield, sink, file);
      const key = entryId(res.key, rfield, sink, file);
      if (key === undefined) {
        resourcesOk = false;
        return;
      }
      if (resourceKeys[key]) {
        err(sink, file, rfield, `contains duplicate key ${key}`);
        resourcesOk = false;
        return;
      }
      resourceKeys[key] = true;
      const resourceTools = stringList(res.tools, `${rfield}.tools`, sink, file);
      if (
        resourceTools.length === 0 ||
        resourceTools.some((tool) => !connectorTools.includes(tool))
      ) {
        err(sink, file, rfield, "must constrain at least one declared connector tool");
        resourcesOk = false;
        return;
      }
      const label = requiredString(res.label, `${rfield}.label`, 200, sink, file);
      if (label === undefined) {
        resourcesOk = false;
        return;
      }
      resources.push({ key, label, tools: resourceTools });
    });
    if (!resourcesOk) return;
    const label = requiredString(entry.label, `${field}.label`, 200, sink, file);
    if (label === undefined) return;
    const description = optionalString(
      entry.description,
      `${field}.description`,
      1000,
      sink,
      file,
    );
    if (description === undefined) return;
    const connector = {
      id,
      label,
      description,
      required: entry.required === true,
      tools: connectorTools,
      resources,
    };
    // Remote MCP only: an optional https endpoint declares the single server
    // identity the runtime may bind. Local-execution servers (stdio/command)
    // are rejected: declaring one must never authorize host-level execution.
    if (entry.command !== undefined || entry.args !== undefined || entry.transport === "stdio") {
      err(sink, file, field, "local-execution MCP servers are unsupported: declare a remote endpoint only");
      return;
    }
    if (entry.endpoint !== undefined) {
      const endpoint = optionalUrl(entry.endpoint, `${field}.endpoint`, sink, file);
      if (endpoint === undefined) return;
      if (!endpoint.startsWith("https://")) {
        err(sink, file, `${field}.endpoint`, "must be an https URL");
        return;
      }
      connector.endpoint = endpoint;
    }
    out.push(connector);
  });
  return out;
}

function normalizeMountPath(raw, sink, file) {
  if (typeof raw !== "string") {
    err(sink, file, "workspace mount path", "must be a string");
    return undefined;
  }
  const path = raw.trim();
  if (path === "./") return "./";
  if (!path.startsWith("./")) {
    err(sink, file, "workspace mount path", "must be canonical ./ or ./name");
    return undefined;
  }
  const rest = path.slice(2);
  if (!rest || rest.length > 200) {
    err(sink, file, "workspace mount path", "must be canonical ./ or ./name");
    return undefined;
  }
  if (rest.endsWith("/")) {
    err(sink, file, "workspace mount path", "must not end with /");
    return undefined;
  }
  const segments = rest.split("/");
  if (segments.length > 5) {
    err(sink, file, "workspace mount path", "is too deep");
    return undefined;
  }
  for (const segment of segments) {
    if (!MOUNT_SEGMENT_RE.test(segment) || segment === "." || segment === "..") {
      err(sink, file, "workspace mount path", "must be canonical ./ or ./name");
      return undefined;
    }
  }
  const lowered = segments.map((s) => s.toLowerCase());
  if (lowered.includes("..")) {
    err(sink, file, "workspace mount path", "must not contain traversal");
    return undefined;
  }
  if (RESERVED_TOP[lowered[0]] === true) {
    err(sink, file, "workspace mount path", "is reserved");
    return undefined;
  }
  if (segments.some((s) => s.startsWith("."))) {
    err(sink, file, "workspace mount path", "is reserved");
    return undefined;
  }
  return "./" + segments.join("/");
}

function isPrefixPath(parent, child) {
  if (parent === "./") return true;
  if (parent === child) return true;
  return child.startsWith(parent + "/");
}

export function validateWorkspaceMounts(input, sink, file) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    err(sink, file, "workspace", "must be an array");
    return [];
  }
  if (input.length > 10) {
    err(sink, file, "workspace", "has too many mounts");
    return [];
  }
  const mounts = [];
  input.forEach((entry, i) => {
    const field = `workspace[${i}]`;
    if (!isRecord(entry)) {
      err(sink, file, field, "must be an object");
      return;
    }
    checkKeys(entry, ["path"], field, sink, file);
    const path = normalizeMountPath(entry.path, sink, file);
    if (path === undefined) return;
    mounts.push({ id: `workspace-${sha256Hex(path).slice(0, 32)}`, path });
  });
  const paths = {};
  for (const mount of mounts) {
    if (paths[mount.path] === true) {
      err(sink, file, "workspace", `contains duplicate mount path ${mount.path}`);
    }
    paths[mount.path] = true;
  }
  if (mounts.some((m) => m.path === "./") && mounts.length > 1) {
    err(sink, file, "workspace", "mount ./ is exclusive and cannot be combined");
  }
  for (let i = 0; i < mounts.length; i++) {
    for (let j = 0; j < mounts.length; j++) {
      if (i === j) continue;
      if (isPrefixPath(mounts[i].path, mounts[j].path)) {
        err(
          sink,
          file,
          "workspace",
          `mounts ${mounts[i].id} and ${mounts[j].id} overlap`,
        );
        i = mounts.length;
        break;
      }
    }
  }
  return mounts;
}

export function validateGithubActions(input, sink, file) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    err(sink, file, "githubActions", "must be an array");
    return [];
  }
  if (input.length > GITHUB_ACTIONS.length) {
    err(sink, file, "githubActions", "has too many entries");
    return [];
  }
  const seen = {};
  const out = [];
  input.forEach((entry, i) => {
    if (typeof entry !== "string" || !GITHUB_ACTIONS.includes(entry)) {
      err(
        sink,
        file,
        `githubActions[${i}]`,
        "must be one of read_issue, push_branch, pull_request, comment_issue",
      );
      return;
    }
    if (seen[entry] === true) {
      err(sink, file, "githubActions", `contains duplicate ${entry}`);
      return;
    }
    seen[entry] = true;
    out.push(entry);
  });
  return out;
}

function validateInputField(entry, i, sink, file) {
  const field = `triggers.inputs[${i}]`;
  if (!isRecord(entry)) {
    err(sink, file, field, "must be an object");
    return undefined;
  }
  checkKeys(
    entry,
    ["key", "label", "type", "required", "default", "options", "help"],
    field,
    sink,
    file,
  );
  if (typeof entry.key !== "string" || !INPUT_KEY_RE.test(entry.key)) {
    err(sink, file, `${field}.key`, "is invalid");
    return undefined;
  }
  if (
    entry.type !== "string" &&
    entry.type !== "number" &&
    entry.type !== "boolean" &&
    entry.type !== "select"
  ) {
    err(sink, file, `${field}.type`, "must be string, number, boolean, or select");
    return undefined;
  }
  const out = { key: entry.key, type: entry.type };
  const label = optionalText(entry.label, `${field}.label`, 100, sink, file);
  if (label !== undefined) out.label = label;
  if (entry.required !== undefined) {
    if (typeof entry.required !== "boolean") {
      err(sink, file, `${field}.required`, "must be a boolean");
      return undefined;
    }
    if (entry.required) out.required = true;
  }
  if (entry.default !== undefined) {
    const d = entry.default;
    const ok =
      (entry.type === "string" && typeof d === "string" && d.length <= 2000) ||
      (entry.type === "number" && typeof d === "number" && Number.isFinite(d)) ||
      (entry.type === "boolean" && typeof d === "boolean") ||
      (entry.type === "select" && typeof d === "string" && d.length <= 200);
    if (!ok) {
      err(sink, file, `${field}.default`, "does not match the input type");
      return undefined;
    }
    out.default = d;
  }
  if (entry.options !== undefined || entry.type === "select") {
    if (
      !Array.isArray(entry.options) ||
      entry.options.length === 0 ||
      entry.options.length > 50
    ) {
      err(
        sink,
        file,
        `${field}.options`,
        "must be a non-empty array of at most 50 strings for select inputs",
      );
      return undefined;
    }
    const seen = {};
    const options = [];
    for (let j = 0; j < entry.options.length; j++) {
      const option = entry.options[j];
      if (typeof option !== "string" || !option.trim() || option.length > 200) {
        err(sink, file, `${field}.options[${j}]`, "must be a non-empty string up to 200 characters");
        return undefined;
      }
      if (seen[option]) {
        err(sink, file, `${field}.options`, "contains duplicates");
        return undefined;
      }
      seen[option] = true;
      options.push(option);
    }
    out.options = options;
    if (
      out.default !== undefined &&
      typeof out.default === "string" &&
      !seen[out.default]
    ) {
      err(sink, file, `${field}.default`, "must be one of the select options");
      return undefined;
    }
  }
  const help = optionalText(entry.help, `${field}.help`, 500, sink, file);
  if (help !== undefined) out.help = help;
  return out;
}

export function validateTriggerDefinitions(input, sink, file) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    err(sink, file, "triggers", "must be an array");
    return [];
  }
  if (input.length > 20) {
    err(sink, file, "triggers", "has too many entries");
    return [];
  }
  const seen = {};
  const out = [];
  input.forEach((entry, i) => {
    const field = `triggers[${i}]`;
    if (!isRecord(entry)) {
      err(sink, file, field, "must be an object");
      return;
    }
    checkKeys(
      entry,
      [
        "label",
        "description",
        "kind",
        "eventTypes",
        "repository",
        "inputs",
        "deciderRole",
        "deciderInstructions",
        "enabledByDefault",
      ],
      field,
      sink,
      file,
    );
    let ok = true;
    if (entry.kind !== TRIGGER_KIND_GITHUB) {
      err(sink, file, `${field}.kind`, "must be github");
      ok = false;
    }
    if (
      !Array.isArray(entry.eventTypes) ||
      entry.eventTypes.length === 0 ||
      entry.eventTypes.length > 20
    ) {
      err(
        sink,
        file,
        `${field}.eventTypes`,
        "must be a non-empty array of at most 20 event types",
      );
      ok = false;
    }
    const seenTypes = {};
    const eventTypes = [];
    if (Array.isArray(entry.eventTypes)) {
      entry.eventTypes.forEach((type, j) => {
        if (
          typeof type !== "string" ||
          !type.trim() ||
          type.length > 120 ||
          !EVENT_TYPE_RE.test(type.trim())
        ) {
          err(sink, file, `${field}.eventTypes[${j}]`, "is invalid");
          ok = false;
          return;
        }
        const normalized = type.trim();
        if (seenTypes[normalized]) {
          err(sink, file, `${field}.eventTypes`, "contains duplicates");
          ok = false;
          return;
        }
        seenTypes[normalized] = true;
        eventTypes.push(normalized);
      });
    }
    const label = requiredString(entry.label, `${field}.label`, 100, sink, file);
    const deciderInstructions = requiredString(
      entry.deciderInstructions,
      `${field}.deciderInstructions`,
      20000,
      sink,
      file,
    );
    if (label === undefined || deciderInstructions === undefined) ok = false;
    if (!ok) return;
    const id = `trigger-${sha256Hex(label).slice(0, 32)}`;
    if (seen[id]) {
      err(sink, file, `${field}.label`, `contains duplicate trigger label ${label}`);
      return;
    }
    seen[id] = true;
    const definition = {
      id,
      label,
      kind: TRIGGER_KIND_GITHUB,
      eventTypes,
      deciderInstructions,
    };
    const description = optionalText(
      entry.description,
      `${field}.description`,
      2000,
      sink,
      file,
    );
    if (description !== undefined) definition.description = description;
    if (entry.repository !== undefined) {
      if (!isRecord(entry.repository)) {
        err(sink, file, `${field}.repository`, "must be an object");
        return;
      }
      checkKeys(entry.repository, ["mode", "fullName"], `${field}.repository`, sink, file);
      const mode = entry.repository.mode;
      if (mode !== "any" && mode !== "pinned") {
        err(sink, file, `${field}.repository.mode`, "must be any or pinned");
        return;
      }
      const fullName = optionalText(
        entry.repository.fullName,
        `${field}.repository.fullName`,
        201,
        sink,
        file,
      );
      if (mode === "pinned") {
        if (fullName === undefined || !REPO_FULL_NAME_RE.test(fullName)) {
          err(
            sink,
            file,
            `${field}.repository.fullName`,
            "must be a full repository name owner/repo",
          );
          return;
        }
        definition.repository = { mode, fullName };
      } else {
        if (fullName !== undefined && !REPO_FULL_NAME_RE.test(fullName)) {
          err(
            sink,
            file,
            `${field}.repository.fullName`,
            "must be a full repository name owner/repo",
          );
          return;
        }
        definition.repository =
          fullName === undefined ? { mode } : { mode, fullName };
      }
    }
    if (entry.inputs !== undefined) {
      if (!Array.isArray(entry.inputs) || entry.inputs.length > 50) {
        err(
          sink,
          file,
          `${field}.inputs`,
          "must be an array of at most 50 inputs",
        );
        return;
      }
      const keys = {};
      const inputs = [];
      for (let j = 0; j < entry.inputs.length; j++) {
        const validated = validateInputField(entry.inputs[j], j, sink, file);
        if (!validated) return;
        if (keys[validated.key]) {
          err(sink, file, `${field}.inputs`, `contains duplicate key ${validated.key}`);
          return;
        }
        keys[validated.key] = true;
        inputs.push(validated);
      }
      definition.inputs = inputs;
    }
    if (entry.deciderRole !== undefined) {
      if (typeof entry.deciderRole !== "string" || !MODEL_ROLES.includes(entry.deciderRole)) {
        err(
          sink,
          file,
          `${field}.deciderRole`,
          "must be one of default, smol, slow, plan",
        );
        return;
      }
      definition.deciderRole = entry.deciderRole;
    }
    if (entry.enabledByDefault !== undefined) {
      if (typeof entry.enabledByDefault !== "boolean") {
        err(sink, file, `${field}.enabledByDefault`, "must be a boolean");
        return;
      }
      definition.enabledByDefault = entry.enabledByDefault;
    }
    out.push(definition);
  });
  return out;
}


export { err, warn };
export { requiredString, optionalString, optionalText, entryId };
