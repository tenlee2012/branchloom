# Branchloom CLI reference

The machine protocol version for this Skill is `3`.

## Installation

Branchloom desktop installs the native CLI and this Skill together from its **AI 工具** page. The
matching files are bundled with the desktop release, so installation is offline and does not need
Node.js, npm, npx, or a background service.

If `branchloom` is missing or contract version `3` is incompatible, stop and ask the user to open
that page and install, update, or repair both tools. An Agent must not copy package-internal
binaries, write directly into the shared Agent Skill directory, or suggest legacy npm/npx
installation. Branchloom desktop installs this Skill at `~/.agents/skills/branchloom`.

## Command model

```text
branchloom <resource> <action> [options]
```

Resources:

- `project`
- `person`
- `organization`
- `career`
- `title`
- `relationship`
- `event`
- `place`
- `source`
- `citation`
- `attachment`
- `github`
- `batch` (only `run`)

Special command: `doctor`.

Use `<resource> describe --output json` to retrieve current actions, scope, fields, filters, enum
values, and write schemas. Only `schemaStatus: published` is safe for schema-driven AI writes.

Project packages and GitHub:

- `project snapshot --id <project-id> --note <snapshot-name>`
- `project export --id <project-id> --destination /absolute/file.blp`
- `project import --source /absolute/file.blp`
- `project export --id <project-id> --destination /absolute/file.ged`
- `project import --source /absolute/file.ged`
- `github connect --project <project-id> --owner <owner> --repo <repo>`
- `github status --project <project-id>`
- `github pull --project <project-id>`
- `github sync --project <project-id>`

`.blp` is a ZIP container whose extracted project tree matches the GitHub working tree. GitHub
commands use the native Rust Git Data/LFS client and do not require system Git.

`.ged` and `.gedcom` select GEDCOM exchange automatically; `--format gedcom` is also accepted.
GEDCOM import/export uses the same preview, etag, overwrite, and destructive-confirmation protocol.
Inspect `summary.warnings` because GEDCOM does not preserve every Branchloom extension record.

## Scope and input

- `project` is unscoped.
- Every other business resource requires `--project <project-id>`.
- `get`, `update`, `delete`, and `remove` use `--id <entity-id>`.
- Use either field options or `--input <absolute-json-file>`, never both.
- `--project` is a scope option, so it is valid and required together with `--input`.
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

High-risk apply:

```bash
branchloom relationship add \
  --project <project-id> \
  --input /absolute/path/relationship.json \
  --apply \
  --if-match <etag> \
  --confirm-destructive <destructiveConfirmation> \
  --output json
```

### Skill approval modes

Approval modes are Branchloom Skill behavior, not separate CLI flags. The CLI always returns a
preview first and requires the matching `etag` for apply.

- **Interactive mode** asks the user to confirm each concrete preview.
- **Autonomous import mode** is enabled only by explicit user authorization for a named project and
  bounded import scope. It may automatically apply `person/event/source/citation create`, a normal
  project snapshot, and additive `relationship add` after checking the preview.
- Autonomous apply requires a new target, stable same-project references, no warnings, no cascade,
  and unchanged replay of `etag` and any `destructiveConfirmation`.
- `update`, `delete`, `remove`, project import, overwrite, cascade, ambiguity, duplicates, warnings,
  validation failures, revision conflicts, and changed previews always pause for user direction.
- Autonomous sessions report a checkpoint after 20 applied writes or a meaningful domain boundary
  instead of interrupting after each record.

An autonomous session normally issues two CLI commands per write. When one requested unit contains
only new people and additive relationships, use the atomic batch command below instead of separate
writes.

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

Refs are unique and backward-only. Preview returns stable planned IDs, `refMap`, one `etag`, and—if
the batch contains a relationship—one `destructiveConfirmation`. Apply the unchanged file with both
tokens. The shared core commits all actions in one transaction, increments the data revision once,
and returns one `changeSetId`. A failed action rolls back every action. The file is limited to 100
actions and 10 MiB. Stdin, update, overwrite, delete, and non-person/relationship actions are not
supported by this batch subset.

The person payload may include structured `birth` and `death` fields; recording a person's birth
does not require an `event/create` unless the user explicitly asks for an event. A relationship may
include existing same-project source IDs in `sourceIds`. Creating a missing source, creating a
separate event, or creating a formal citation is outside this batch subset and cannot be silently
split from an atomic request.

Create a manual restorable snapshot (normal-risk write):

```bash
branchloom project snapshot \
  --id <project-id> \
  --note "Before review" \
  --output json

branchloom project snapshot \
  --id <project-id> \
  --note "Before review" \
  --apply --if-match <etag> \
  --output json
```

The core writes the snapshot metadata and its restorable normalized-state payload atomically. A
blank note is rejected, and a concurrent project change invalidates the preview etag.

Set a person avatar from a local file (normal-risk write):

```bash
branchloom attachment import \
  --project <project-id> \
  --person <person-id> \
  --file /absolute/path/avatar.png \
  --output json

branchloom attachment import \
  --project <project-id> \
  --person <person-id> \
  --file /absolute/path/avatar.png \
  --apply --if-match <etag> \
  --output json
```

The CLI canonicalizes the path, copies the file into Branchloom-managed local storage, hashes it,
deduplicates identical content, and replaces the person's current `avatar` link. Never put binary
data or base64 into JSON input. Do not expose or upload the image content.

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
- `1`: internal error
- `2`: command, JSON, or schema error
- `3`: not found
- `4`: revision, etag, or write-lock conflict
- `5`: permission, configuration, data directory, or contract incompatibility

In JSON mode, stdout contains one final envelope and stderr is empty.

## GitHub conflicts

Never run a GitHub command unless the user explicitly requested external synchronization. Never
print, persist, or put `BRANCHLOOM_GITHUB_TOKEN` into an input file.

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
