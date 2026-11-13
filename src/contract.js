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
  "publish_attachments", "merge_change_request",
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
export const WHATSAPP_CAPABILITIES = Object.freeze(["read_messages", "send_text", "set_reaction", "remove_reaction"]);
export const WHATSAPP_TRIGGER_EVENT_TYPES = Object.freeze(["message.created", "reaction.changed"]);
