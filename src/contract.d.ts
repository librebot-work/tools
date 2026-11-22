export const FORMAT_VERSION: 1;
export const MODEL_ROLES: readonly ["default", "smol", "slow", "plan"];
export const BUILT_IN_MODEL_ROLES: readonly ["default", "smol", "slow", "plan"];
export const MAX_MODEL_ROLES: 8;
export const RESERVED_MODEL_ROLE_IDS: readonly string[];
export const CUSTOM_MODEL_ROLE_ID_RE: RegExp;
export function isReservedModelRoleId(role: string): boolean;
export function isBuiltInModelRole(role: string): role is BuiltInModelRoleId;
export function isCustomModelRoleId(role: string): boolean;
export function isModelRoleId(role: string): role is ModelRoleId;
export const REPO_CAPABILITIES: readonly [
  "read_issue", "push_branch", "propose_change", "comment_issue",
  "search_issues", "read_change_request", "read_repository",
  "update_issue_labels", "react_issue", "update_issue_body", "update_issue_title",
  "publish_attachments", "merge_change_request", "comment_change_request",
  "read_issue_artifacts", "write_issue_artifacts",
];
export const GITREPO_TRIGGER_EVENT_TYPES: readonly [
  "issue.opened", "issue.updated", "issue.closed", "issue.reopened",
  "issue.comment.created", "issue.comment.updated",
  "change_request.opened", "change_request.updated", "change_request.closed",
  "change_request.reopened", "change_request.merged", "change_request.commits_updated",
  "change_request.checks_updated",
  "change_request.comment.created", "change_request.comment.updated",
  "change_request.approval_changed", "repository.pushed",
];
export const GITREPO_TRIGGER_EVENT_SOURCES: Readonly<Record<GitrepoTriggerEventType, { readonly github: readonly string[]; readonly gitlab: readonly string[] }>>;
export const WHATSAPP_CAPABILITIES: readonly ["read_messages", "send_text", "set_reaction", "remove_reaction"];
export const WHATSAPP_TRIGGER_EVENT_TYPES: readonly ["message.created", "reaction.changed"];
export const GOOGLE_ACTION_KINDS: readonly ["google_docs", "google_sheets", "google_calendar"];
export const GOOGLE_DOCS_CAPABILITIES: readonly ["search_documents", "read_document", "create_document", "edit_document_content", "format_document"];
export const GOOGLE_SHEETS_CAPABILITIES: readonly ["search_spreadsheets", "read_spreadsheet", "create_spreadsheet", "write_values", "append_values", "write_formulas", "format_cells"];
export const GOOGLE_CALENDAR_CAPABILITIES: readonly ["search_events", "read_event", "create_event", "edit_event", "cancel_event", "manage_attendees"];
export const DECIDER_READ_CAPABILITIES: readonly [
  "read_issue", "search_issues", "read_change_request", "read_repository", "read_issue_artifacts",
  "read_messages",
  "search_documents", "read_document", "search_spreadsheets", "read_spreadsheet", "search_events", "read_event",
];
export type DeciderReadCapability = typeof DECIDER_READ_CAPABILITIES[number];

export type BuiltInModelRoleId = typeof MODEL_ROLES[number];
export type ModelRoleId = string;
export type RepoCapability = typeof REPO_CAPABILITIES[number];
export type GitrepoTriggerEventType = typeof GITREPO_TRIGGER_EVENT_TYPES[number];
export type WhatsAppCapability = typeof WHATSAPP_CAPABILITIES[number];
export type WhatsAppTriggerEventType = typeof WHATSAPP_TRIGGER_EVENT_TYPES[number];
export type GoogleActionKind = typeof GOOGLE_ACTION_KINDS[number];
export type GoogleDocsCapability = typeof GOOGLE_DOCS_CAPABILITIES[number];
export type GoogleSheetsCapability = typeof GOOGLE_SHEETS_CAPABILITIES[number];
export type GoogleCalendarCapability = typeof GOOGLE_CALENDAR_CAPABILITIES[number];
export const UPGRADE_PRIORITIES: readonly ["action", "notable"];
export const MAX_UPGRADE_SUMMARY_CODEPOINTS: 280;
export function validateUpgradeNote(summary: unknown, priority: unknown): void;

export type UpgradePriority = typeof UPGRADE_PRIORITIES[number];
export type { CronSchedule } from "./cron.js";
export {
  CRON_TRIGGER_EVENT_TYPES,
  validateCronSchedule,
  nextCronOccurrence,
  latestCronOccurrence,
} from "./cron.js";
