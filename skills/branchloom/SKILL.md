---
name: branchloom
description: Read and manage local genealogy data in Branchloom (有谱) through its installed CLI, or diagnose that CLI's setup. Use for stored project data and continued data work. Repository development, documentation audits, and general genealogy questions do not activate this skill.
---

# Branchloom

Use the installed `branchloom` command for user-requested data operations. Do not access SQLite,
managed attachments, or sync baselines directly, or substitute package-internal binaries or Tauri
commands. Repository development follows the checkout's `AGENTS.md`; this installed-data workflow
does not require developers to access user data or prohibit authorized edits to skill source files.

## Before accessing data

- Run `branchloom doctor --output json` once before the task's first data operation, using the
  user's selected `--data-dir` or `--profile` if supplied. Otherwise preserve the configured default;
  never switch directories to work around an error. Development tests use isolated temporary data.
- Require `ok: true`, `data.compatible: true`, contract version `3`, and the needed capabilities.
  If the command is missing or incompatible, direct the user to desktop's **AI 工具** page to
  install, update, or repair CLI and Skill together. Do not manually install or copy deployed tools,
  modify installed skill files, or recommend npm/npx as a workaround.
- Use `--output json` and parse the envelope for every call. Use `<resource> describe --output json`
  for fields or actions not established in this task; schema-driven writes require
  `schemaStatus: published`. Read [command and capability details](references/cli-reference.md#command-model)
  only as needed. Do not invent unpublished maintenance, person-merge, history, or batch actions.

## Resolve identities and prepare input

- Resolve the project and referenced entities to stable IDs before writing. Name matches are
  candidates; use available context to disambiguate, and ask with small candidate summaries if the
  identity remains uncertain. Never write to the first match by default.
- Request only relevant `--fields` and associations. Do not fetch biographies, notes, excerpts, or
  unrelated relatives by default. Summarize naturally with necessary IDs, warnings, and sources;
  show raw JSON only when requested or needed for troubleshooting.
- Put complex input in a protected OS temporary JSON file readable only by the current user, pass
  its absolute path through `--input`, and remove it after apply, cancellation, or task completion.
  Do not use stdin, `--input -`, executable content, or interpolate data into shell commands.
- `--project` supplies the authoritative scope and can accompany `--input`. Omit system-managed
  `id`, `projectId`, `revision`, `createdAt`, and `updatedAt`; do not mix business field flags with
  `--input`. Keep temporary inputs outside the user's repository unless explicitly requested.
- Names are embedded values with no name ID; each person needs unique name values and exactly one
  primary name. Self-relations and cycles are permitted; do not reject or question unusual family
  relationships merely because they are unusual.

## Preview and authorization

The CLI's two-phase protocol and conversational approval are separate requirements. Existing
authorization remains valid within its task, project, and scope until revoked. User instructions
take precedence over procedural preferences in this skill; they do not remove the CLI's preview,
etag, or destructive-token checks. Prepare permitted reads, inputs, and previews before asking
for approval, so the user can review the actual change.

1. Preview the intended command without `--apply`; `--preview` is not a valid option.
2. Require `data.status: preview`. Inspect the target, patch, affected entities, cascade, warnings,
   risk flag, `etag`, and any `destructiveConfirmation`. For a batch, also check every action and
   `refMap`. Changed input, target, related data, or external state invalidates the old preview.
3. Apply only under one of the modes below. Replay the same command and input with
   `--apply --if-match <etag>` and, when returned, `--confirm-destructive <destructiveConfirmation>`.
   Never invent, alter, or substitute tokens with `--yes`.
4. Verify the applied response and report the target and `changeSetId` when returned. Do not claim
   success from a preview. Recover using [actual CLI errors](references/cli-reference.md#error-recovery).

**Interactive mode is the default.** Explain the concrete preview and obtain confirmation before
apply. A request to add, update, delete, import, or export data permits preparation of that preview;
it does not by itself authorize continuous writes. If the user already confirmed this unchanged
preview, apply without asking again.

**Autonomous additive import requires explicit authorization** for continuous writes without
per-record confirmation to a named project and bounded dataset, such as “无需逐条确认，连续导入…”.
Do not ask again to activate a clearly authorized session. State the project ID, allowed operations,
checkpoint interval, and stop conditions once, then follow these limits:

- Allowed operations: `person/event/source/citation create`, additive `relationship add`, a batch
  containing only `person/create` and `relationship/add`, and a normal-risk manual project snapshot.
- Each entity create/add must be new; all references must resolve within the same project. Every
  preview must have no warnings or cascade. Relationship additions, including batches, still need
  the returned destructive token.
- Before a substantial import into a project that already has data, create a named manual snapshot
  through its normal preview/apply workflow. See [snapshot commands](references/cli-reference.md#snapshots-and-avatars).
- Report progress at the user's requested checkpoints; otherwise after 20 applied writes or a
  meaningful domain boundary, whichever comes first. Include counts, necessary IDs, warnings, and
  the latest `changeSetId` without adding per-record confirmation questions.
- Pause autonomous writes before updates, deletions/removals, project import, overwrite, cascade,
  unresolved identity, cross-project references, duplicates, warnings, validation failures,
  revision/etag conflicts, changed previews, or unexpected external-state changes. Present the
  concrete issue and seek direction; additive authorization does not cover these operations.

Deletion is immediate hard deletion, with no trash or soft-delete recovery. Destructive change-sets
contain no deleted business payload and cannot be reverted; a separate prior snapshot is not an
automatic undo. All relationship mutations, deletes/removes, and cascades are high risk.

When a rule here requires pausing or confirmation, link this skill or the relevant reference, quote
the applicable clause, and explain the specific action it affects. Continue independent authorized
preparation; do not turn a workflow preference into an additional approval requirement.

## Specialized operations

- For an atomic group of new people and relationships, use [batch run](references/cli-reference.md#atomic-person-and-relationship-batch).
  Never split an atomic request after a failure or silently include unsupported actions. Birth facts
  normally belong in the person's `birth` field; a separate event or newly created source/citation
  lies outside this batch subset.
- For field shapes and associations, read only the relevant [person](references/cli-reference.md#person-input),
  [event](references/cli-reference.md#event-input), [relationship](references/cli-reference.md#relationship-input),
  or [source/citation](references/cli-reference.md#source-and-citation-input) section. Use stable
  same-project references and preserve historical date uncertainty without inventing boundaries.
- Import an avatar with the [local-file command](references/cli-reference.md#snapshots-and-avatars).
  Pass only the user-provided absolute file path; do not inspect, encode, print, upload, or copy image
  bytes yourself. The shared core handles copying, hashing, and deduplication.
- Use [project exchange commands](references/cli-reference.md#project-exchange) for `.blp` and GEDCOM;
  report `summary.warnings` for lossy GEDCOM exchange.
- GitHub synchronization requires an explicit request for that external action. For conflicts, use
  [GitHub commands and resolution files](references/cli-reference.md#github-conflicts), collect the
  user's choice for each conflict, and never push unresolved conflicts.

Keep data, inputs, attachments, and diagnostic details local. Uploading them or using a web service
to interpret local records requires separate explicit authorization for that external action.
