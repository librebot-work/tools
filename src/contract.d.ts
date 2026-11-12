export const FORMAT_VERSION: 1;
export const MODEL_ROLES: readonly ["default", "smol", "slow", "plan"];
export const REPO_CAPABILITIES: readonly [
  "read_issue", "push_branch", "propose_change", "comment_issue",
  "search_issues", "read_change_request", "read_repository",
  "update_issue_labels", "react_issue", "update_issue_body", "update_issue_title",
  "publish_attachments", "merge_change_request",
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
export const WHATSAPP_CAPABILITIES: readonly ["read_messages", "send_text", "set_reaction", "remove_reaction"];
export const WHATSAPP_TRIGGER_EVENT_TYPES: readonly ["message.created", "reaction.changed"];

export type ModelRoleId = typeof MODEL_ROLES[number];
export type RepoCapability = typeof REPO_CAPABILITIES[number];
export type GitrepoTriggerEventType = typeof GITREPO_TRIGGER_EVENT_TYPES[number];
export type WhatsAppCapability = typeof WHATSAPP_CAPABILITIES[number];
export type WhatsAppTriggerEventType = typeof WHATSAPP_TRIGGER_EVENT_TYPES[number];
