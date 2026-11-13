# librebot-tools

Public source-format tooling for Librebot bots: parse, validate, preview,
scaffold, and external-skill lock resolution. Standalone ESM package, no
build step, hand-written types in `src/index.d.ts`.

## Source format (v1)

```text
bot.yaml                 # identity, description, format version, model roles,
                         # workspace mounts, triggers, actions, connectors
instructions.md          # main prompt (-> BotDraft.botPrompt)
README.md                # required user documentation (-> BotDraft.readme)

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
- Required root `README.md` becomes `draft.readme`: strict UTF-8, trimmed,
  non-empty, and at most 100000 characters after trimming.
  It is presentation-only user documentation, never `botPrompt` or knowledge,
  and is distinct from the optional `knowledge/README.md` index.
  Export requires a non-empty string `draft.readme` and writes it back to root
  `README.md`; sources without root documentation fail validation.
  New scaffolds include a user-manual README skeleton (purpose, limits, what
  you need, getting started, examples, what the bot changes) for the author
  to complete; it is published on new bot pages as-is.
- Optional root `icon` is a repository-relative SVG, PNG, or WebP path.
  New scaffolds include `icon: ./assets/icon.svg` and the default bot glyph.
  Raster images must be square (512 × 512 recommended, not required); SVG
  requires a square viewBox. Maximum edge is 4096 and maximum file size is
  256 KiB. Transparent backgrounds, colored shapes, groups, transforms,
  gradients, local fragment references, and allowlisted inline presentation
  styles are supported. Scripts, event handlers, external references,
  stylesheets, fonts, images, animation, DOCTYPE, and entities are rejected.
  Prefer simple artwork with adequate padding.
- Parsed `icon` is separate from knowledge and contains
  `{ path, bytes, mime, sha256, size, width, height }`; `draft.icon` retains
  the normalized `./` source reference. Export with
  `exportBotFiles(parsed.draft, { icon: parsed.icon, assets: parsed.assets,
  skillFiles: parsed.skillFiles })`. An icon reference without asset bytes
  fails export rather than inventing replacement artwork. CLI preview shows
  metadata only, never icon bytes.
- Visibility is platform-managed and is not a source field. Workspace mounts,
  action groups, and triggers declare explicit stable `key` values. Mounts have
  `path`, actions and triggers use common `kind: gitrepo`; provider and target
  bindings belong to instances. Connectors retain unique labels and platform
  identities. Knowledge source IDs remain portable references.
- `modelRoles[]` accepts optional `requirements: { tools?, vision?,
-   reasoning?, minContextWindow? }`, validated and preserved end to end.
- Role ids are `default` (required), the reserved OMP built-ins `smol`,
- `slow`, `plan`, or custom ids such as `frontend_dev_model`: start with a
- letter or digit, then letters/digits with `-`/`_` only, max 64 chars.
- Custom ids must avoid all reserved ids: the four built-ins plus the OMP
- built-in names `vision`, `commit`, `tiny`, `memory`, `task`, `advisor`,
- `widget`, `image`, `web`, `speech`, `dictation`, `judge` and the unsafe
- object keys `__proto__`, `constructor`, `prototype` (no dots).
- Up to 8 roles may be declared. A trigger `deciderRole` may name any
- declared role. Custom roles never inherit workspace model defaults: every
- custom role needs an explicit instance model binding, while defaults cover
- the built-ins only.
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
  parseBotFiles,   // (files: Record<string, Uint8Array|string>) -> { formatVersion, draft, icon?, assets, skillFiles, warnings, source, lock }
  parseBotSource,  // (dir) -> same; throws BotSourceError on invalid source
  validateFiles,   // non-throwing: { ok, errors, warnings, ... }
  validateSource,  // (dir) -> same; never throws on invalid source (only on IO)
  scaffoldBotFiles, // ({ name, description? }) -> Record<string, string>
  scaffoldBot,     // (dir, input, { force? }) -> written paths
  exportBotFiles,  // (draft, { icon?: {bytes}, assets?, skillFiles?, sourcesText?, lockText? }) -> file map
  resolveSkillsLock, // ({ sources, existingLock?, update?, network?, vendor?, fetchImpl? })
  fetchLockedSkills, // (lock, { fetchImpl? }) -> { vendorFiles, errors }
  readTarEntries,  // (tarball bytes) -> [{ name, bytes, skipped }]; Recht-safe tar: skips specials, rejects traversal, enforces caps
  loadSchema,      // ('v1') -> bot.yaml JSON Schema object
} from "librebot-tools";
```

- `validateSource(dir)` return shape: `{ ok: true, errors: [], warnings,
  formatVersion, draft, icon?, assets, skillFiles, source, lock }` or
  `{ ok: false, errors: [{ file, field, message }], warnings }`. It never
  throws for invalid source (filesystem failures throw natively).
  `parseBotSource(dir)` throws `BotSourceError` (with `.errors[]` /
  `.warnings[]`) instead. Same contract for `validateFiles` / `parseBotFiles`.
- `librebot-tools/contract` exports the portable vocabulary with no Node
  dependencies, so browsers can import it too: `FORMAT_VERSION`,
  `MODEL_ROLES` (reserved OMP built-ins `default`, `smol`, `slow`, `plan`),
  `BUILT_IN_MODEL_ROLES` (alias), `MAX_MODEL_ROLES` (8),
  `CUSTOM_MODEL_ROLE_ID_RE`, `isBuiltInModelRole`, `isCustomModelRoleId`,
  `isModelRoleId`, plus `REPO_CAPABILITIES`, `GITREPO_TRIGGER_EVENT_TYPES`,
  `WHATSAPP_CAPABILITIES`, `WHATSAPP_TRIGGER_EVENT_TYPES` (frozen arrays), and
  the derived `ModelRoleId` (generic string: built-in or custom),
  `BuiltInModelRoleId`, `RepoCapability`, `WhatsAppCapability`,
  `GitrepoTriggerEventType`, and `WhatsAppTriggerEventType` types. The root
  entry re-exports the same values.
- No author-configured shell commands are executed. Standard skill
  installation uses fixed CLI arguments only after explicit local
  `--network --vendor` consent; source locators are passed as arguments,
  never shell strings. GitHub commit pins use bounded, hash-verified HTTP.

## Portable repository declarations

Workspace slots, action groups, and triggers have independent explicit stable
`key` values (up to 64 characters, letters/digits followed by letters/digits,
periods, underscores, or hyphens). Keys are unique within each section.

```yaml
workspace:
  - key: source
    label: Source checkout
    path: ./repo
actions:
  - key: issues
    kind: gitrepo
    capabilities: [read_issue, comment_issue, propose_change]
triggers:
  - key: new-issue
    label: New issue
    kind: gitrepo
    eventTypes: [issue.opened]
    deciderInstructions: Decide whether this issue needs assistance.
```

Action capabilities are `read_issue`, `push_branch`, `propose_change`,
`comment_issue`, `search_issues`, `read_change_request`, `read_repository`,
`update_issue_labels`, `react_issue`, `update_issue_body`, `update_issue_title`,
`publish_attachments` (GitHub only: uploads task-local SVG/PNG files as issue
attachments, posts one comment embedding them, and optionally transitions labels
after the comment is confirmed; it needs an owner-linked upload token on the
GitHub connection, and GitLab bindings are rejected), and
`merge_change_request`.
Groups require at least one capability; at most 20 groups are accepted.
API-only actions do not require workspace. Platform bindings select the provider,
connection, numeric repository identity, and optional checkout independently.
`push_branch` requires a bound matching checkout. Native `repo_*` tools select
the declared group through required `action`, never a freeform repository.

Semantic trigger events are `issue.opened`, `issue.updated`, `issue.closed`,
`issue.reopened`, `issue.comment.created`, `issue.comment.updated`,
`change_request.opened`, `change_request.updated`, `change_request.closed`,
`change_request.reopened`, `change_request.merged`,
`change_request.commits_updated`, `change_request.checks_updated`,
`change_request.comment.created`,
`change_request.comment.updated`, `change_request.approval_changed`, and
`repository.pushed`. Repository selection belongs only in instance bindings.
Legacy provider-specific action fields/kinds, derived IDs, and pinned trigger
repositories are rejected. Messaging declarations are not implemented and are
rejected by the runtime/schema.

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

## Publishing

Releases use `.github/workflows/publish.yml` on GitHub-hosted runners with npm
trusted publishing (OIDC). No npm token or per-release browser approval is needed.
The npm package's Trusted Publisher must authorize organization `librebot-work`,
repository `tools`, workflow filename `publish.yml`, with direct `npm publish`
allowed and no environment name.

After the compatible platform contract is ready, commit the version change and
lockfile, merge it to `main`, then push a matching stable version tag:

```sh
git tag v0.4.7
git push origin v0.4.7
```

Use the new package version, not an already published version. The workflow
requires the tag to match `package.json` and point to a commit reachable from
`main`, installs dependencies, runs tests, inspects the package, and publishes.
Protect `main` and restrict creation/update/deletion of `v*` tags to release
maintainers: pushing a release tag authorizes publishing. npm trusted publisher
setup must complete its first successful publish within two days; otherwise
recreate that configuration when a release is ready.

## Platform integration

- The platform pins the exact npm release in its dependency manifest and lockfile.
  API/runtime ingestion and the Git validator install the same version.
- Bot authors use `npx --yes --package=librebot-tools@latest librebot ...`.
  Custom model roles require version `0.4.6` or newer; publish a compatible
  platform release before adopting a newer source contract.
- Portable `actions` also accept `kind: whatsapp` with only `read_messages`,
  `send_text`, `set_reaction`, and `remove_reaction`. Repository capabilities
  remain exclusive to `gitrepo`. Exact sender-phone bindings, independent read
  context, destination policies, and automated-write consent belong to owner
  instance settings, never portable source. Version 0.4.1 added this parser/schema
  contract; 0.4.2 replaces the scaffold README with a user-manual skeleton;
  0.4.3 adds the `publish_attachments` repository capability; 0.4.4 adds the
  `merge_change_request` repository capability and the
  `change_request.checks_updated` trigger event; 0.4.6 adds custom model role
  ids (up to 8 roles including `default`; workspace defaults stay built-in-only
  while custom roles require explicit instance bindings).
  Custom-role sources require tooling at 0.4.6 or newer; 0.4.5 accepts only
  `default`, `smol`, `slow`, `plan`.
- Portable WhatsApp triggers use `kind: whatsapp`, semantic `message.created`
  and/or `reaction.changed`, and the existing keyed decider definition fields.
  Event namespaces are checked against the selected trigger kind.
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
mounts <= 10; model roles 1-8 including `default` (reserved built-ins
`default`, `smol`, `slow`, `plan` plus custom ids such as `frontend_dev_model`);
SKILL.md <= 50,000 bytes
and non-empty; text knowledge <= 100,000 chars inline (empty files inline
as empty content, matching platform acceptance); knowledge assets
<= 10 MiB; skill supporting files <= 1 MiB each.
