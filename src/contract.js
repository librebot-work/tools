// Portable source-contract vocabulary. Dependency-free and browser-safe so
// platform UIs and servers can import it (`librebot-tools/contract`) instead
// of keeping their own copies of these lists.

export const FORMAT_VERSION = 1;
export const MODEL_ROLES = Object.freeze(["default", "smol", "slow", "plan"]);
export const BUILT_IN_MODEL_ROLES = MODEL_ROLES;
export const MAX_MODEL_ROLES = 8;
// Reserved ids beyond the four portable built-ins: OMP built-in agent/model
// role names plus dangerous object keys. Custom ids must avoid all of these;
// only default/smol/slow/plan are portable workspace defaults.
export const RESERVED_MODEL_ROLE_IDS = Object.freeze([
  "default", "smol", "slow", "plan",
  "vision", "commit", "tiny", "memory", "task", "advisor", "widget",
  "image", "web", "speech", "dictation", "judge",
  "__proto__", "constructor", "prototype",
]);
export function isReservedModelRoleId(role) {
  return RESERVED_MODEL_ROLE_IDS.includes(role);
}
// Custom model role ids: safe slugs that never collide with reserved OMP
// built-in names. Dots are excluded so role ids stay usable as binding keys
// and selectors.
export const CUSTOM_MODEL_ROLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function isBuiltInModelRole(role) {
  return MODEL_ROLES.includes(role);
}
export function isCustomModelRoleId(role) {
  return typeof role === "string" && CUSTOM_MODEL_ROLE_ID_RE.test(role) && !isReservedModelRoleId(role);
}
export function isModelRoleId(role) {
  return isBuiltInModelRole(role) || isCustomModelRoleId(role);
}
export const REPO_CAPABILITIES = Object.freeze([
  "read_issue", "push_branch", "propose_change", "comment_issue",
  "search_issues", "read_change_request", "read_repository",
  "update_issue_labels", "react_issue", "update_issue_body", "update_issue_title",
  "publish_attachments", "merge_change_request", "comment_change_request",
  "read_issue_artifacts", "write_issue_artifacts",
]);
export const GITREPO_TRIGGER_EVENT_TYPES = Object.freeze([
  "issue.opened", "issue.updated", "issue.closed", "issue.reopened",
  "issue.comment.created", "issue.comment.updated",
  "change_request.opened", "change_request.updated", "change_request.closed",
  "change_request.reopened", "change_request.merged", "change_request.commits_updated",
  "change_request.checks_updated",
  "change_request.comment.created", "change_request.comment.updated",
  "change_request.approval_changed", "repository.pushed",
]);
// Provider deliveries that produce each semantic repository event. Values
// name the GitHub App "Subscribe to events" entries and the GitLab project
// webhook triggers that must be enabled for the event to arrive.
const source = (github, gitlab) => Object.freeze({ github: Object.freeze(github), gitlab: Object.freeze(gitlab) });
export const GITREPO_TRIGGER_EVENT_SOURCES = Object.freeze({
  "issue.opened": source(["Issues"], ["Issues events"]),
  "issue.updated": source(["Issues"], ["Issues events"]),
  "issue.closed": source(["Issues"], ["Issues events"]),
  "issue.reopened": source(["Issues"], ["Issues events"]),
  "issue.comment.created": source(["Issue comment"], ["Comments"]),
  "issue.comment.updated": source(["Issue comment"], ["Comments"]),
  "change_request.opened": source(["Pull request"], ["Merge request events"]),
  "change_request.updated": source(["Pull request"], ["Merge request events"]),
  "change_request.closed": source(["Pull request"], ["Merge request events"]),
  "change_request.reopened": source(["Pull request"], ["Merge request events"]),
  "change_request.merged": source(["Pull request"], ["Merge request events"]),
  "change_request.commits_updated": source(["Pull request"], ["Merge request events"]),
  "change_request.checks_updated": source(["Check run", "Check suite", "Workflow run", "Status"], ["Pipeline events"]),
  "change_request.comment.created": source(["Issue comment", "Pull request review comment"], ["Comments"]),
  "change_request.comment.updated": source(["Issue comment", "Pull request review comment"], ["Comments"]),
  "change_request.approval_changed": source(["Pull request review"], ["Merge request events"]),
  "repository.pushed": source(["Push"], ["Push events"]),
});
export const WHATSAPP_CAPABILITIES = Object.freeze(["read_messages", "send_text", "set_reaction", "remove_reaction"]);
export const WHATSAPP_TRIGGER_EVENT_TYPES = Object.freeze(["message.created", "reaction.changed"]);
export const GOOGLE_ACTION_KINDS = Object.freeze(["google_docs", "google_sheets", "google_calendar"]);
export const GOOGLE_DOCS_CAPABILITIES = Object.freeze(["search_documents", "read_document", "create_document", "edit_document_content", "format_document"]);
export const GOOGLE_SHEETS_CAPABILITIES = Object.freeze(["search_spreadsheets", "read_spreadsheet", "create_spreadsheet", "write_values", "append_values", "write_formulas", "format_cells"]);
export const GOOGLE_CALENDAR_CAPABILITIES = Object.freeze(["search_events", "read_event", "create_event", "edit_event", "cancel_event", "manage_attendees"]);
// Explicit allowlist: new action capabilities are not automatically usable by routers.
export const DECIDER_READ_CAPABILITIES = Object.freeze([
  "read_issue", "search_issues", "read_change_request", "read_repository", "read_issue_artifacts",
  "read_messages",
  "search_documents", "read_document", "search_spreadsheets", "read_spreadsheet", "search_events", "read_event",
]);

// Author-written release note for the next publish: one trimmed line of
// plain text (1-280 Unicode code points). `upgradePriority` ("action" for a
// concrete user step, "notable" for a material change needing no step)
// requires a summary. Both fields are optional; releases without
// user-visible changes omit them. Server-resolved `sourceCommit`/`sourceTag`
// are never author input. Shared with platform validation and Git history
// so every surface enforces identical rules; platform catches the thrown
// Error as badRequest.
export const UPGRADE_PRIORITIES = Object.freeze(["action", "notable"]);
export const MAX_UPGRADE_SUMMARY_CODEPOINTS = 280;
// C0/C1 controls, line/paragraph separators: single-line plain text only.
const UPGRADE_SUMMARY_CONTROL_RE = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + String.fromCharCode(127) + "-" + String.fromCharCode(159) + String.fromCharCode(8232) + String.fromCharCode(8233) + "]");
/**
 * Validate an author-written upgrade note. Throws an Error whose message
 * names the offending field (`upgradeSummary` or `upgradePriority`).
 * @param {unknown} summary
 * @param {unknown} priority
 */
export function validateUpgradeNote(summary, priority) {
  if (summary === undefined) {
    if (priority === undefined) return;
    throw new Error("upgradePriority requires upgradeSummary");
  }
  if (typeof summary !== "string") {
    throw new Error("upgradeSummary must be a string");
  }
  const trimmed = summary.trim();
  if (!trimmed) {
    throw new Error("upgradeSummary must not be empty");
  }
  if ([...trimmed].length > MAX_UPGRADE_SUMMARY_CODEPOINTS) {
    throw new Error(`upgradeSummary must be at most ${MAX_UPGRADE_SUMMARY_CODEPOINTS} characters`);
  }
  if (UPGRADE_SUMMARY_CONTROL_RE.test(trimmed)) {
    throw new Error("upgradeSummary must be single-line plain text without control or separator characters");
  }
  if (priority === undefined) return;
  if (priority !== "action" && priority !== "notable") {
    throw new Error('upgradePriority must be "action" or "notable"');
  }
}
export {
  CRON_TRIGGER_EVENT_TYPES,
  validateCronSchedule,
  nextCronOccurrence,
  latestCronOccurrence,
} from "./cron.js";
