---
name: branchloom
description: Operate local Branchloom (有谱) genealogy projects through the branchloom CLI. Use when the user explicitly mentions Branchloom/有谱 or continues work on a Branchloom project. Supports privacy-minimized reads, schema-driven person writes, confirmed previews, relationships, sources, GitHub synchronization, project packages, and diagnostics. Do not trigger for general genealogy questions that do not involve Branchloom data.
---

# Branchloom

Use the `branchloom` command to access Branchloom data. Never open or modify its SQLite database or attachment directory directly.
The command launches the native Rust CLI. Do not call package-internal JavaScript, Rust binaries,
Tauri commands, or storage files as an alternative; both desktop and CLI behavior must flow through
the shared Rust application core.

## Start safely

1. On the first Branchloom operation in a task, run:

   ```bash
   branchloom doctor --output json
   ```

2. If the command is missing, stop and ask the user to open Branchloom desktop's **AI 工具** page
   and install the matching CLI and Skill. Do not install, copy, or upgrade either tool yourself,
   and do not recommend npm, npx, or a package-internal binary.
3. Require `compatible: true`, contract version `3`, and the capabilities needed for the task.
   Schema-driven writes require the matching capability: `event.write-schema`,
   `relationship.write-schema`, `source.write-schema`, or `citation.write-schema`. Atomic person
   and relationship batches require `batch.person-relationship-atomic`. GEDCOM exchange requires
   `project.gedcom-exchange`.
4. Preserve the default data directory unless the user explicitly supplied a profile or data directory.
5. Use `--output json` for every call. Parse the JSON envelope; never infer status from prose.

See [CLI reference](references/cli-reference.md) when command shape, fields, or error recovery is unclear.

## Read with minimal exposure

- Resolve a project to its stable project ID before project-scoped work.
- Use stable IDs for `get` and every write.
- A search result is only a candidate resolver. Never write to “the first” name match.
- If multiple people match, present small candidate summaries and ask the user to choose.
- Request only task-relevant fields with `--fields`; expand associations only when needed.
- Do not fetch biographies, private notes, citation excerpts, or unrelated relatives by default.
- Summarize results naturally. Include the IDs, warnings, and sources needed for traceability.
- Show raw JSON only when the user asks or it is needed for troubleshooting.

## Prepare structured input

For complex writes:

1. Create a JSON file in the operating system temporary directory.
2. Restrict its permissions to the current user.
3. Pass its absolute path through `--input`.
4. Do not use stdin, `--input -`, shell interpolation, embedded commands, or executable content.
5. Keep the file until apply, cancellation, or task completion; then make a best effort to remove it.

Use `--project <project-id>` together with `--input` for every project-scoped create. `--project`
is the authoritative scope, not a business field. The JSON file must omit system-managed `id`,
`projectId`, `revision`, `createdAt`, and `updatedAt`; the CLI rejects them instead of silently
overriding them.

Do not place temporary input in the user’s repository unless they explicitly request that.

Person names are embedded in the person object. A person has one UUID, one or more unique name values, and exactly one primary name. There is no name resource or name ID.

## Choose an approval mode

The CLI is always two-phase: preview first, then apply the unchanged operation with its returned
tokens. The approval mode controls whether the user must confirm each preview in the conversation.

Use **interactive mode** by default. Use **autonomous import mode** only when the user explicitly
authorizes continuous writes without per-record confirmation for a named project and a bounded
import scope. Phrases such as “无需逐条确认”, “连续导入直到完成”, or “后续自动导入” are explicit
authorization when the project and intended dataset are clear from the current task. The
authorization lasts only for the current task, project, and scope, and the user may revoke it at
any time.

Before the first autonomous write, state the project ID, allowed resource operations, checkpoint
interval, and stop conditions. Do not ask for another confirmation merely to activate a clearly
authorized autonomous session.

### Preview every write

In both modes:

1. Run the intended command without `--apply`.
   Do not add `--preview`; preview is the default mode and `--preview` is not a valid option.
2. Verify `data.status` is `preview` and inspect the target, field patch, affected entities,
   cascade, warnings, risk flag, `etag`, and any `destructiveConfirmation`.
3. If input, target, related data, or external state changes, discard the preview and preview again.
4. Never replace the destructive token with `--yes`, and never generate or modify either token.

### Apply in interactive mode

Explain the complete preview and stop for the user to confirm it. After confirmation, rerun the
exact same business command and input with:

```text
--apply --if-match <etag>
```

If the preview returned `destructiveConfirmation`, also pass:

```text
--confirm-destructive <token>
```

### Apply in autonomous import mode

Automatically apply a preview without another user prompt only when all of these conditions hold:

- The operation is within the explicitly approved project and import scope.
- It is `person/event/source/citation create`, a normal-risk project snapshot, or
  `relationship add`.
- The target is new, every referenced entity has been resolved by stable ID in the same project,
  and the preview has no warnings or cascade.
- The exact input and preview tokens are replayed unchanged. For `relationship add`, pass the
  returned `destructiveConfirmation` unchanged even though the operation is additive.

At the beginning of a substantial autonomous import, create a named manual project snapshot before
the first entity write when the project already contains data. Apply the normal-risk snapshot under
the same autonomous authorization after checking its preview.

Report progress after every 20 applied writes or at a meaningful domain boundary, whichever comes
first. Include applied resource counts, stable IDs needed for traceability, warnings, and the most
recent `changeSetId`; do not interrupt progress with a confirmation question.

Pause autonomous mode and ask for direction before any `update`, `delete`, `remove`, project import,
overwrite, cascade, ambiguous identity choice, cross-project reference, duplicate conflict, warning,
validation error, revision/etag conflict, changed preview, or unexpected external-state change.
These conditions change the authorized plan rather than merely adding another record.

In either mode, report the applied target and `changeSetId` when the command returns one.

### Batch new people and relationships atomically

Use `batch run` when one user request requires multiple new people and additive relationships to
succeed or fail together. The current batch contract supports only `person/create` and
`relationship/add`; do not use it for updates, overwrites, deletes, or other resources.

Write one protected temporary JSON file with this shape:

```json
{
  "actions": [
    {
      "resource": "person",
      "action": "create",
      "ref": "new-parent",
      "payload": {
        "names": [{ "value": "Li Mei", "type": "personal", "primary": true }]
      }
    },
    {
      "resource": "relationship",
      "action": "add",
      "payload": {
        "fromPersonId": { "ref": "new-parent" },
        "toPersonId": "existing-child-id",
        "category": "parent",
        "type": "biological"
      }
    }
  ]
}
```

A `ref` is unique within one batch. A structured `{ "ref": "..." }` may reference only an earlier
action; never use string interpolation or forward references. Preview with:

```text
branchloom batch run --project <project-id> --input <absolute-json-file> --output json
```

Verify every planned ID, `refMap`, patch, affected entity, warning, `etag`, and
`destructiveConfirmation`. A batch containing a relationship is high risk. In interactive mode,
show the complete batch and wait for one confirmation. In an explicitly authorized autonomous
additive import, apply without another prompt only if every action is a new supported create/add,
all references resolve in the same project, and the preview has no warnings or cascade. Replay the
same file and both tokens unchanged. Report the single returned `changeSetId`; never fall back to
separate writes after a batch failure.

Keep facts that belong to the person inside the `person/create` payload. In particular, “record the
person's birth” normally means the structured person `birth` field; do not invent a separate birth
event unless the user explicitly requested an event. An already resolved same-project source can be
associated with the new relationship through `sourceIds`, so this remains within the atomic subset.
If the source itself must be created, or the user explicitly requires a separate event or formal
`citation` record, explain that those actions are outside this batch subset and stop before splitting
the requested atomic write.

## Treat these operations as high risk

- Any `delete` or `remove`
- Project deletion
- Any relationship mutation. Additive `relationship add` may proceed in autonomous import mode only
  under the conditions above; `update` and `remove` always pause for explicit direction.
- Any cascade

All deletion is immediate hard deletion. There is no trash, restore, soft delete, tombstone, or purge. Destructive change-sets cannot be reverted and contain no deleted business payload.

## Use business commands

- Use `relationship add/update/remove` with explicit parent/child or person-a/person-b roles.
- Relationship `category` and `type` must agree: `parent` uses `biological`, `adoptive`, `step`,
  or `guardian`; `partner` uses `engaged`, `married`, `partner`, `separated`, or `divorced`.
  Referenced people, optional place, and sources must all exist in the same project.
- Create a `source` before using its stable ID in events, relationships, or citations. Source type
  is `book`, `archive`, `web`, `interview`, or `other`.
- Use `citation` for evidence linking. Citations target people or other entities, never an embedded
  person name. The supported target types are `person`, `relationship`, `event`, and `career`; the
  source and target must exist in the same project.
- Use `event create/update` only with stable participant, place, and source IDs. Every
  `participantRoles` key must also appear in `participantIds`. Preserve historical uncertainty with
  the structured `date.precision` and ISO date boundaries instead of putting unparsed dates into
  `date.display`.
- To set a person avatar, use `attachment import --project <project-id> --person <person-id>
  --file <absolute-local-image-path> --output json`. Treat it as a normal two-phase write. Pass only
  a user-provided local file path; never inline, encode, inspect, print, upload, or copy the image
  yourself. Require the `attachment.person-avatar-local-file` capability. The CLI copies and
  deduplicates the content through the shared Rust core.
- Treat person names as embedded values with `value`, `type`, and `primary`; exactly one name must
  have `primary: true`.
- Call `describe` before a write when the current task needs fields not covered by this Skill. Only
  write when `schemaStatus` is `published`; otherwise report that the installed CLI has not yet
  published a safe write schema for that resource.
- Use `project export/import` for `.blp` packages and `.ged` / `.gedcom` exchange files. The
  extracted `.blp` tree is the same format stored in GitHub. GEDCOM operations use the same
  preview/apply and destructive-confirmation rules; always report `summary.warnings` because
  GEDCOM cannot preserve every Branchloom extension record.
- Use `github pull` for pull-only updates and `github sync` for pull/merge/push. GitHub operations
  require the user to explicitly request external synchronization.
- When GitHub preview reports conflicts, collect explicit `base`, `ours`, or `theirs` choices for
  every reported path and field, write them to a protected temporary JSON file, and rerun preview
  with `--resolutions`. Never push unresolved conflicts.

Do not invent commands for history, maintenance, participation, person merge, unsupported batch
resources/actions, or attachment lifecycle operations beyond the documented person-avatar import.
They are not part of the current public CLI contract.

Branchloom intentionally permits unconventional genealogy data, including self-relations and cycles. Do not “correct,” reject, or question such content merely because it looks unusual.

## Recover from errors

- `NOT_FOUND`: re-resolve the stable project/entity ID.
- `REVISION_CONFLICT`, `ETAG_MISMATCH`, or `INVALID_ETAG`: rerun the preview and ask for confirmation of the new plan.
- `DUPLICATE_RELATIONSHIP`: use the existing relationship ID and `relationship update` if the user wants a type change.
- `RESOURCE_IN_USE`: show the blocking references; do not silently delete or clear them.
- `CONTRACT_VERSION_MISMATCH`: stop. Ask the user to open Branchloom desktop's **AI 工具** page
  and update CLI and Skill together.
- Data directory, permission, storage, or lock errors: run `branchloom doctor --output json` once and report its focused findings.
- Unknown fields or actions: call the resource’s `describe --output json`, correct the structured request, and preview again.

Do not retry a write by weakening validation, changing data directories, or bypassing confirmation.

## Stay offline

Do not upload Branchloom data, command inputs, attachments, or errors. Do not use web services to interpret local genealogy records unless the user separately and explicitly requests that external action.
