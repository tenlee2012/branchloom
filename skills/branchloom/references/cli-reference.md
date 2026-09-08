# Branchloom CLI reference

The machine protocol version is `3`. Read only the sections needed for the operation.
Conversational approval rules live in [SKILL.md](../SKILL.md#preview-and-authorization);
the examples below describe CLI syntax and do not grant permission to apply.

## Installation

Desktop's **AI 工具** page installs matching CLI and Skill files from its offline bundle; no Node.js
or background service is needed. The deployed skill directory is `~/.agents/skills/branchloom`.
For a missing or incompatible installation, follow [startup handling](../SKILL.md#before-accessing-data).

## Command model

```text
branchloom <resource> <action> [options]
```

Resources: `project`, `person`, `organization`, `career`, `title`, `relationship`, `event`, `place`,
`source`, `citation`, `attachment`, `github`, and `batch` (only `run`). Special command: `doctor`.

Use `<resource> describe --output json` to retrieve current actions, scope, fields, filters, enum
values, and write schemas. Only `schemaStatus: published` is safe for schema-driven AI writes.
`batch` has no `describe` action; check its capability and the batch section below.

Check the relevant entries in `doctor.data.capabilities`:

| Operation | Capability |
| --- | --- |
| Schema discovery | `describe.write-schema` |
| Event, relationship, source, or citation writes | `event.write-schema`, `relationship.write-schema`, `source.write-schema`, or `citation.write-schema`, respectively |
| Atomic people and relationships | `batch.person-relationship-atomic` |
| Local avatar import | `attachment.person-avatar-local-file` |
| GEDCOM exchange | `project.gedcom-exchange` |

## Project exchange

- `project export --id <project-id> --destination /absolute/file.blp`
- `project import --source /absolute/file.blp`
- `project export --id <project-id> --destination /absolute/file.ged`
- `project import --source /absolute/file.ged`

Append `--output json` and use the preview/apply protocol for these commands. `.blp` is a ZIP
container whose extracted project tree matches the GitHub working tree.

`.ged` and `.gedcom` select GEDCOM exchange automatically; `--format gedcom` is also accepted.
GEDCOM import/export uses the same preview, etag, overwrite, and destructive-confirmation protocol.
Inspect `summary.warnings` because GEDCOM does not preserve every Branchloom extension record.
An import over an existing project ID requires `--overwrite` and the returned destructive token.

## Scope and input

- `project` is unscoped.
- Scoped data operations require `--project <project-id>`; `describe` does not require a project.
- `get`, `update`, `delete`, and `remove` use `--id <entity-id>`.
- Use either field options or `--input <absolute-json-file>`, never both.
- For project-scoped resources, `--project` remains required with `--input`.
- Input JSON must not contain `id`, `projectId`, `revision`, `createdAt`, or `updatedAt`.
- JSON input only comes from a file. Stdin is unsupported.
- `--data-dir` and `--profile` are mutually exclusive.

## Writes

Preview:

```bash
branchloom person create \
  --project <project-id> \
  --input /absolute/path/person.json \
  --output json
```

Preview is the default. There is no `--preview` option.

Apply after user confirmation in interactive mode, or after autonomous-mode checks pass:

```bash
branchloom person create \
  --project <project-id> \
  --input /absolute/path/person.json \
  --apply \
  --if-match <etag> \
  --output json
```

If the preview returned `destructiveConfirmation`, also append
`--confirm-destructive <destructiveConfirmation>` to the unchanged command.

## Atomic person and relationship batch

```bash
branchloom batch run \
  --project <project-id> \
  --input /absolute/path/actions.json \
  --output json
```

The input root is `{ "actions": [...] }`. Each action has `resource`, `action`, optional `ref`, and
`payload`. The current public subset accepts only `person/create` and `relationship/add`:

```json
{
  "actions": [
    {
      "resource": "person",
      "action": "create",
      "ref": "mother",
      "payload": {
        "names": [{ "value": "Li Mei", "type": "personal", "primary": true }]
      }
    },
    {
      "resource": "relationship",
      "action": "add",
      "payload": {
        "fromPersonId": { "ref": "mother" },
        "toPersonId": "existing-child-id",
        "category": "parent",
        "type": "biological"
      }
    }
  ]
}
```

Refs are unique and backward-only; use structured `{ "ref": "..." }` references, not interpolation.
Preview returns stable planned IDs, `refMap`, one `etag`, and, if the batch contains a relationship,
one `destructiveConfirmation`. Apply the unchanged file with `--if-match` and the destructive token
when returned. One transaction increments the data revision once and returns one `changeSetId`;
a failed action rolls back all actions. Limit: 100 actions and 10 MiB. The batch subset does not
accept stdin, updates, overwrites, deletes, or other resources.

The person payload may include structured `birth` and `death` fields; recording a person's birth
does not require an `event/create` unless the user explicitly asks for an event. A relationship may
include existing same-project source IDs in `sourceIds`. Creating a missing source, creating a
separate event, or creating a formal citation is outside this batch subset and cannot be silently
split from an atomic request.

## Snapshots and avatars

Preview a manual restorable snapshot (normal-risk write):

```bash
branchloom project snapshot \
  --id <project-id> \
  --note "Before review" \
  --output json
```

Apply using the [write protocol](#writes). Snapshot metadata and its restorable normalized-state
payload are saved atomically. The note must be nonblank; concurrent changes invalidate the preview.

Preview setting a person avatar from a local file (normal-risk write):

```bash
branchloom attachment import \
  --project <project-id> \
  --person <person-id> \
  --file /absolute/path/avatar.png \
  --output json
```

Apply using the same protocol. The core copies and hashes the local file, deduplicates identical
content, and replaces the person's `avatar` link. Do not put image bytes or base64 in JSON, or
expose or upload the image content.

## Person input

Names are embedded values and have no ID:

```json
{
  "names": [
    { "value": "赵匡胤", "type": "personal", "primary": true },
    { "value": "元朗", "type": "courtesy", "primary": false }
  ],
  "sex": "male",
  "status": "deceased",
  "biography": "...",
  "notes": "..."
}
```

The CLI rejects duplicate normalized name values, unknown fields, name IDs, multiple primary names,
and system-managed top-level fields. Missing `sex`, `status`, `biography`, and `notes` receive safe
defaults during preview.

## Event input

Events use stable IDs for every association:

```json
{
  "type": "accession",
  "title": "赵匡胤即皇帝位",
  "date": {
    "precision": "exact",
    "start": "0960-02-04"
  },
  "participantIds": ["person-id"],
  "participantRoles": {
    "person-id": "即位者"
  },
  "sourceIds": [],
  "notes": "史料说明"
}
```

`type` is an open non-empty string, so research-specific event types are allowed. Missing
`participantIds`, `sourceIds`, and `notes` receive empty defaults. Participant and source IDs must
be unique; every role key must occur in `participantIds`; person, place, and source references must
exist in the same project.

Date boundaries use `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`. `exact` and `about` require at least one
boundary, `before` requires `end`, `after` requires `start`, `range` requires both, and `unknown`
accepts no boundaries. The core validates real calendar dates and rejects reversed ranges.
For CLI writes, `date.display` is a desktop compatibility field, not storage for unparsed source
text; preserve uncertainty with `precision` and only supply boundaries supported by the source.

## Relationship input

Relationships use the `add` action and are always high risk:

```json
{
  "fromPersonId": "parent-person-id",
  "toPersonId": "child-person-id",
  "category": "parent",
  "type": "biological",
  "sourceIds": ["source-id"],
  "notes": "史料说明"
}
```

For `category: parent`, `type` is `biological`, `adoptive`, `step`, or `guardian`. For
`category: partner`, `type` is `engaged`, `married`, `partner`, `separated`, or `divorced`.
`sourceIds` and `notes` receive empty defaults. Both people, an optional `placeId`, and every source
must exist in the same project. Self-relations and cycles are permitted by the data model.

## Source and citation input

Create the source first:

```json
{
  "title": "宋史",
  "type": "book",
  "author": "脱脱等",
  "date": { "precision": "about", "start": "1345" },
  "referenceCode": "卷一 本纪第一",
  "notes": ""
}
```

Source `type` is `book`, `archive`, `web`, `interview`, or `other`. Then link evidence to a stable
entity ID with a citation:

```json
{
  "sourceId": "source-id",
  "targetType": "person",
  "targetId": "person-id",
  "locator": "卷一 本纪第一",
  "excerpt": "节录或校勘说明",
  "notes": ""
}
```

Citation `targetType` is `person`, `relationship`, `event`, or `career`. The source and target must
exist in the same project. Missing `notes` receives an empty default.

## JSON envelope

Success:

```json
{
  "ok": true,
  "contractVersion": 3,
  "data": {},
  "warnings": [],
  "page": null
}
```

Failure:

```json
{
  "ok": false,
  "contractVersion": 3,
  "error": {
    "code": "STABLE_CODE",
    "message": "English message",
    "details": null
  }
}
```

Exit codes:

- `0`: success, including previews
- `1`: core or I/O error
- `2`: command, JSON, or schema error
- `3`: not found
- `4`: stale preview, revision/sync conflict, or missing/mismatched destructive confirmation
- `5`: unsupported database schema version

In JSON mode, stdout contains one final envelope and stderr is empty.

## Error recovery

Use `error.code` and details from the returned envelope; do not infer success from exit code alone.

| Code or condition | Response |
| --- | --- |
| `NOT_FOUND` | Re-resolve the stable project/entity ID; do not choose another candidate silently. |
| `STALE_PREVIEW`, `REVISION_CONFLICT` | Discard old tokens, prepare a fresh preview, and obtain confirmation of the new plan. Pause autonomous writes. |
| `DESTRUCTIVE_CONFIRMATION_REQUIRED` | Check the reviewed preview and replay its destructive token only after the applicable approval; do not invent a token or use `--yes`. |
| `SYNC_CONFLICT` | Collect explicit conflict choices and preview again as described below. |
| `UNKNOWN_OPTION`, `UNSUPPORTED_ACTION`, `UNSUPPORTED_RESOURCE`, `VALIDATION_ERROR` | Check `describe` and error details. Correct preparation errors without changing intent; duplicates, blocked references, or plan changes need direction. Autonomous writes pause on validation failure. |
| `UNSUPPORTED_VERSION`, incompatible doctor result, or unexpected contract version | Stop data operations and repair CLI and Skill together through desktop. |
| Data directory, profile, permission, storage, or lock failure | Run doctor once with the same selected scope and report focused findings. Configuration errors may use exit code `2`; I/O errors use `1`. |

Do not retry by weakening validation, switching data directories, deleting blocking references,
or bypassing approval. For an uncertain apply result, verify the outcome before attempting another
write; do not blindly repeat creates.

## GitHub conflicts

`github describe` and `github status --project <project-id>` inspect local information.
`github connect`, `pull`, and `sync` contact GitHub even during preview and require an explicit
request for that external action:

- `github connect --project <project-id> --owner <owner> --repo <repo>`
- `github pull --project <project-id>`
- `github sync --project <project-id>`

Append `--output json`; apply uses the same preview tokens. The native Rust Git Data/LFS client
does not require system Git. CLI authentication uses `BRANCHLOOM_GITHUB_TOKEN` from the process
environment; never print it or put it in inputs, project files, or logs.

If `connect` previews a missing repository, applying with `--create` creates a private repository
and uploads the current project. Confirm that concrete external effect before applying.

`github sync` always pulls before it pushes. If preview returns conflicts, create an absolute JSON
file containing one choice per conflict:

```json
[
  {
    "path": "data/people/ab/person-id.jsonld",
    "field": "/biography",
    "choice": "ours"
  }
]
```

Pass it through `--resolutions`, rerun preview, explain the resolved result, and ask for confirmation
of the new etag. Never apply while any conflict remains.
