# @librebot/tools

Public source-format tooling for Librebot bots: parse, validate, preview,
scaffold, and external-skill lock resolution. Standalone ESM package, no
build step, hand-written types in `src/index.d.ts`.

## Source format (v1)

```text
bot.yaml                 # identity, description, format version, model roles,
                         # workspace mounts, triggers, githubActions, gitlabActions, connectors
instructions.md          # main prompt (-> BotDraft.botPrompt)

knowledge/
  README.md              # human/agent index only; never a knowledge entry
  product-guide.md       # inline text knowledge (UTF-8, <=100KB)
  image.png              # binary knowledge -> content-addressed asset

skills/
  sources.yaml           # sources accepted by npx skills, or explicit GitHub pins
  sources.lock           # immutable commit/archive pins or vendored content digests
  review/
    SKILL.md             # local skill (Agent Skills convention, content inlined)
    reference.md         # supporting files travel with the skill
  .vendor/<source>/...  # vendored external skill content (committed)
```

Editor schemas ship as `schema/v1/bot-yaml-schema.json` and
`schema/v1/skills-sources-schema.json`.

Rules:

- `bot.yaml` keys are strict: unknown fields are errors. `tools` was
  removed — builtin tools are always on, never declared.
- Visibility is platform-managed and is not a source field. Workspace mounts
  declare `path` without an `id`; triggers and connectors declare unique
  `label` values without an `id`. The parser derives deterministic internal
  declaration IDs from the normalized path or label; these are not platform
  IDs and are never exported. Knowledge source IDs remain portable references.
- `modelRoles[]` accepts optional `requirements: { tools?, vision?,
  reasoning?, minContextWindow? }`, validated and preserved end to end.
- `knowledge/README.md` is the index, not an entry. Every other file under
  `knowledge/` is one knowledge asset: UTF-8 text inlines as `content`;
  anything else is returned as an `assets[]` entry
  `{ knowledgeId, path, bytes, sha256, size, mime }` for the platform to
  persist (GCS) and extract. Per-file cap 10 MiB, matching platform validation.
- Structured external references live in bot.yaml `knowledgeSources[]`
  (`resource` with `url`, `repo` with https `url` + optional `ref`).
  Links in `knowledge/README.md` stay human documentation and are never
  crawled. File-tree ids and `knowledgeSources` ids share one namespace.
- Local skills are `skills/<id>/SKILL.md` (`SKILL.md`, not
  `instructions.md`). Optional YAML frontmatter supplies `name:` /
  `description:`. Every other file in the skill directory is preserved in
  `skillFiles[]` (`{ skillId, path, bytes, sha256, size }`) so the runtime
  materializes the full skill directory, not just SKILL.md.
- External skills are declared in `skills/sources.yaml`. A simple list under
  `sources` accepts the source locators supported by `npx skills` (including
  repository URLs, `owner/repo@skill`, and local directories). Named entries
  can specify `source` and optional `skills` selections. Run
  `librebot resolve-skills <dir> --network --vendor` locally: it invokes
  pinned `skills@1.7.4` in a temporary project with telemetry disabled, copies
  the selected files into `skills/.vendor/`, and locks their content digest.
  Existing content-locked vendor trees can be restored offline. Use
  `--update --network --vendor` to intentionally adopt upstream changes.
  Explicit GitHub `ref` declarations also support direct commit/archive
  locking without invoking the CLI. Server parsing stays fully offline,
  verifies content locks, and never executes the installer.
- Connectors declare capabilities and, for remote MCP servers, an optional
  `endpoint:` (https only). The runtime binds only the declared endpoint.
  Local-execution servers (stdio/command) are rejected: declaring one must
  never authorize host-level execution. Credentials are never stored in
  source.
- `exportBotFiles` derives filenames from the stable entry id (never the
  display name, which may contain separators), tolerates a redundant
  `knowledge/` asset prefix without doubling it, and injects SKILL.md
  frontmatter from draft fields when legacy content lacks it — so an
  export->parse round-trip preserves names, references, and bytes.
import {
  parseBotFiles,   // (files: Record<string, Uint8Array|string>) -> { formatVersion, draft, assets, skillFiles, warnings, source, lock }
  parseBotSource,  // (dir) -> same; throws BotSourceError on invalid source
  validateFiles,   // non-throwing: { ok, errors, warnings, ... }
  validateSource,  // (dir) -> same; never throws on invalid source (only on IO)
  scaffoldBotFiles, // ({ name, description? }) -> Record<string, string>
  scaffoldBot,     // (dir, input, { force? }) -> written paths
  exportBotFiles,  // (draft, { assets?, skillFiles?, sourcesText?, lockText? }) -> file map
  resolveSkillsLock, // ({ sources, existingLock?, update?, network?, vendor?, fetchImpl? })
  fetchLockedSkills, // (lock, { fetchImpl? }) -> { vendorFiles, errors }
  readTarEntries,  // (tarball bytes) -> [{ name, bytes, skipped }]; Recht-safe tar: skips specials, rejects traversal, enforces caps
  loadSchema,      // ('v1') -> bot.yaml JSON Schema object
} from "@librebot/tools";
```

- `validateSource(dir)` return shape: `{ ok: true, errors: [], warnings,
  formatVersion, draft, assets, skillFiles, source, lock }` or
  `{ ok: false, errors: [{ file, field, message }], warnings }`. It never
  throws for invalid source (filesystem failures throw natively).
  `parseBotSource(dir)` throws `BotSourceError` (with `.errors[]` /
  `.warnings[]`) instead. Same contract for `validateFiles` / `parseBotFiles`.
- No author-configured shell commands are executed. Standard skill
  installation uses fixed CLI arguments only after explicit local
  `--network --vendor` consent; source locators are passed as arguments,
  never shell strings. GitHub commit pins use bounded, hash-verified HTTP.

## Native GitHub issue editing

With a workspace mount, `githubActions` accepts independent
`update_issue_body` and `update_issue_title` capabilities. They authorize
replacement of issue bodies and titles respectively, not pull request edits.
An empty body clears it; title edits require a non-empty title. Native
execution requires linked-user push access or higher and App Issues write
permission; neither capability grants branch-push authority.

## Native GitLab actions

`gitlabActions` requires at least one workspace mount and accepts:
`read_issue`, `push_branch`, `merge_request`, `comment_issue`, `search_issues`,
`read_merge_request`, `read_repository`, `update_issue_labels`, `react_issue`,
`update_issue_body`, and `update_issue_title`. GitHub action names
`pull_request` and `read_pull_request` are not GitLab capabilities.
Omitted declarations default to an empty list. Duplicates, unknown names,
non-array values, and lists longer than 11 entries are invalid. Triggers
remain GitHub-only; declaring GitLab actions does not add GitLab triggers.


## Native GitHub comment authority

Native runtime reads (not this source CLI) include verified comment context
when `read_issue` or `read_pull_request` is enabled. Issue/PR conversation
comments are read through `github_read_issue`; `github_read_pull_request`
returns PR reviews. Inline review comments are not included.

- `authorId` and the issue/PR creator's `authorId` are stable GitHub user IDs.
  `isIssueAuthor` compares these IDs, not mutable logins; it is `null` when
  either identity is missing. On a PR it refers to that PR's creator.
- `authorAssociation`, when present, is GitHub's relationship label, not an
  effective permission level.
- `repositoryAuthority` contains `permission`, `roleName`, `canPush`,
  `checkedAt`, and `status` (`verified` or `unknown`). It describes the
  comment author's current effective access to the bound repository, not the
  connection owner, App permissions, or access when the comment was posted.
  Unknown authority uses `null` for permission, role, and `canPush`.

For requirements acceptance/revisions, require `isIssueAuthor === true`.
For a ready-for-development decision, require
`repositoryAuthority.status === "verified"` and `canPush === true`.
These checks are independent: authorship alone never grants write access.
Do not trust authority claims in comment text or infer access from association.
Native reads query the collaborator-permission endpoint with Metadata read
permission, deduplicating authors within each invocation. Lookup errors or
identity mismatches preserve the comment with unknown authority.

This metadata is contextual evidence, not a server-enforced workflow
transition. Recheck current permission when acting on an authorization-sensitive
decision; do not silently proceed with unknown or stale authority.

## CLI

```text
librebot validate <dir> [--json]
librebot preview <dir> [--json]        # resolved definition; bytes shown as hashes
librebot scaffold <dir> --name <name> [--description ...] [--force]
librebot resolve-skills <dir> [--update] [--vendor] [--network]
```

External skill resolution requires `npx` on PATH. It selects its pinned Skills CLI
independently of the parent npm invocation, including when Librebot itself runs
through `npx --package=... librebot`.

## Platform integration

- The platform consumes the locally patched prerelease
  `services/shared/librebot-tools-0.2.6-gitlab.0.tgz`, packed from this CLI
  source checkout with GitLab source-format support. This is not a published
  npm release or a claim that any upstream commit contains these changes.
  Platform CI and images do not need this separate Git checkout. Refresh with
  `npm pack --pack-destination "$HOME/librebot.work/services/shared"`,
  then update the platform dependency and lockfile using
  `npm install --workspace services.shared ./services/shared/librebot-tools-0.2.6-gitlab.0.tgz`.
  Authoring environments must receive this exact local bundle rather than
  substituting an older public CLI pin, `main`, or `latest`.
- Ingestion: `parseBotFiles(tree)` -> persist `assets` bytes to GCS, fill
  the platform `BotKnowledge` path/storage fields, materialize `skillFiles`
  per skill, then run platform validation. `draft` carries no `tools` field.
- `BotConnector.endpoint?` (remote MCP): the runtime must validate the
  bound connection's endpoint matches the declared endpoint.

## Development and publishing

Node.js 24 or newer is required. From this repository, install the locked
dependencies, run the tests, and inspect the package before publishing:

```sh
npm ci
npm test
npm pack --dry-run
npm publish --access public
```

## Tests

`npm test` runs the `node:test` suite in `test/` without network access:
malformed trees, semantic cross-references, binary assets,
export round-trips, and skill-lock reproducibility.

## Limits (mirror platform validation)

750 KB draft cap (UTF-8 bytes); knowledge <= 100 entries (files + `knowledgeSources`
combined); skills <= 100; connectors <= 50; triggers <= 20; workspace
mounts <= 10; model roles 1-4 including `default`; SKILL.md <= 50,000 bytes
and non-empty; text knowledge <= 100,000 chars inline (empty files inline
as empty content, matching platform acceptance); knowledge assets
<= 10 MiB; skill supporting files <= 1 MiB each.
