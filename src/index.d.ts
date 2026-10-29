// Type definitions for @librebot/tools (hand-written; no build step).

export interface SourceIssue {
  file: string;
  field: string;
  message: string;
}

export interface ModelRequirements {
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  minContextWindow?: number;
}

export interface BotModelRole {
  role: "default" | "smol" | "slow" | "plan";
  label: string;
  requirements: ModelRequirements;
}

export interface BotKnowledge {
  id: string;
  name: string;
  kind: "file" | "resource" | "repo";
  content?: string;
  url?: string;
  ref?: string;
}
export interface BotSkill {
  id: string;
  name: string;
  description: string;
  content: string;
}

export interface BotConnector {
  id: string;
  label: string;
  description: string;
  required: boolean;
  tools: string[];
  resources: Array<{ key: string; label: string; tools: string[] }>;
  /** Remote MCP server identity (https URL). Local execution is unsupported. */
  endpoint?: string;
}

export interface BotDraft {
  name: string;
  description: string;
  visibility: "public" | "private";
  botPrompt: string;
  modelRoles: BotModelRole[];
  knowledge: BotKnowledge[];
  skills: BotSkill[];
  connectors: BotConnector[];
  triggers: Record<string, unknown>[];
  workspace: Array<{ id: string; path: string }>;
  githubActions: string[];
}

export interface KnowledgeAsset {
  knowledgeId: string;
  path: string;
  bytes: Uint8Array;
  sha256: string;
  size: number;
  mime: string;
}

export interface SkillFile {
  skillId: string;
  path: string;
  bytes: Uint8Array;
  sha256: string;
  size: number;
}

export interface SourceInventory {
  botYaml: string;
  instructions: string;
  knowledgeFiles: string[];
  skillDirs: string[];
  lockPresent: boolean;
  sourcesPresent: boolean;
}

export interface SkillLockEntry {
  name: string;
  repo: string;
  resolvedSha?: string;
  contentSha256?: string;
  tarballSha256?: string;
  skills: string[];
}

export interface SkillLock {
  version: 1;
  sourcesHash: string;
  resolved: SkillLockEntry[];
  vendorDirs: string[];
}

export interface ParsedBotSource {
  formatVersion: 1;
  draft: BotDraft;
  assets: KnowledgeAsset[];
  skillFiles: SkillFile[];
  warnings: SourceIssue[];
  source: SourceInventory;
  lock: SkillLock | null;
}

export interface ValidationSuccess extends ParsedBotSource {
  ok: true;
  errors: SourceIssue[];
}

export interface ValidationFailure {
  ok: false;
  errors: SourceIssue[];
  warnings: SourceIssue[];
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

export class BotSourceError extends Error {
  errors: SourceIssue[];
  warnings: SourceIssue[];
  constructor(errors: SourceIssue[], warnings?: SourceIssue[]);
}

export function parseBotFiles(
  files: Record<string, Uint8Array | string>,
): Promise<ParsedBotSource>;
export function parseBotSource(dir: string): Promise<ParsedBotSource>;
export function validateFiles(
  files: Record<string, Uint8Array | string>,
): Promise<ValidationResult>;
export function validateSource(dir: string): Promise<ValidationResult>;
export function readDirFiles(dir: string): Promise<Record<string, Uint8Array>>;
export function normalizeFileMap(
  files: Record<string, Uint8Array | string>,
): Map<string, Uint8Array>;
export function knowledgeIdFor(rel: string): string;
export function parseSkillFrontmatter(text: string): {
  name?: string;
  description?: string;
  body: string;
};

export interface SkillRepo {
  owner: string;
  repo: string;
  url: string;
  source?: string;
}

export const LOCK_VERSION: 1;
export const SOURCES_VERSION: 1;
export const MAX_TARBALL_BYTES: number;
export const MAX_DECOMPRESSED_BYTES: number;

export function parseRepo(source: unknown): SkillRepo | null;
export function parseSourcesText(text: string): unknown;
export function serializeLock(lock: SkillLock): string;
export function sourcesHash(
  sources: Array<{ name: string; repo: SkillRepo; ref?: string; skills: string[] }>,
): string;
export function resolveSkillsLock(options: {
  sources: {
    sources: Array<{
      name: string;
      repo: SkillRepo;
      ref?: string;
      skills: string[];
    }>;
  };
  existingLock?: SkillLock;
  update?: boolean;
  network?: boolean;
  vendor?: boolean;
  fetchImpl?: typeof fetch;
  sourceBaseDir?: string;
  currentFiles?: Record<string, Uint8Array>;
}): Promise<{
  lock: SkillLock;
  vendorFiles: Record<string, Uint8Array>;
  errors: SourceIssue[];
  warnings: SourceIssue[];
}>;
export function readTarEntries(buffer: Uint8Array): Array<{
  name: string;
  bytes: Uint8Array;
  skipped: boolean;
}>;
export function fetchLockedSkills(
  lock: SkillLock,
  options?: { fetchImpl?: typeof fetch },
): Promise<{ vendorFiles: Record<string, Uint8Array>; errors: SourceIssue[] }>;

export function scaffoldBotFiles(input: {
  name: string;
  description?: string;
  visibility?: "public" | "private";
}): Record<string, string>;
export function exportBotFiles(
  draft: BotDraft,
  options?: {
    assets?: KnowledgeAsset[];
    skillFiles?: SkillFile[];
    sourcesText?: string;
    lockText?: string;
  },
): Record<string, string | Uint8Array>;
export function scaffoldBot(
  dir: string,
  input: { name: string; description?: string; visibility?: "public" | "private" },
  options?: { force?: boolean },
): Promise<string[]>;
export function writeFiles(
  dir: string,
  files: Record<string, string | Uint8Array>,
): Promise<string[]>;
export function exportKnowledgeFilename(item: {
  id: string;
  name?: string;
}): string;
export function sanitizePathSegment(segment: unknown, what: string): string;
export function sanitizeAssetRel(rel: unknown): string;
export function withSkillFrontmatter(skill: {
  id: string;
  name?: string;
  description?: string;
  content?: string;
}): string;

export const SCHEMA_VERSIONS: string[];
export function loadSchema(version?: string): Promise<Record<string, unknown>>;

export function toBytes(value: Uint8Array | string): Uint8Array;
export function sha256Hex(bytes: Uint8Array | string): string;
export function canonicalJson(value: unknown): string;

export function validateKnowledgeSources(
  input: unknown,
  sink: { errors: SourceIssue[]; warnings: SourceIssue[] },
  file: string,
): BotKnowledge[];
export function validateRequirements(
  input: unknown,
  field: string,
  sink: { errors: SourceIssue[]; warnings: SourceIssue[] },
  file: string,
): ModelRequirements | undefined;
