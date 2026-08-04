import type {
  AttachmentLink,
  Citation,
  DataIssue,
  FamilyEvent,
  Person,
  PersonMergeInput,
  PersonMergeChoices,
  PersonMergeSide,
  PersonMergeSummary,
  Relationship,
  RelationshipConflictChoice,
  RelationshipMergeField,
  UUID,
} from './types'

export interface PersonMergeContext {
  people: Person[]
  relationships: Relationship[]
  events: FamilyEvent[]
  citations: Citation[]
  attachmentLinks: AttachmentLink[]
  issues?: DataIssue[]
}

export interface PersonMergePreview extends PersonMergeContext {
  issues: DataIssue[]
  retainedPerson: Person
  removedPersonId: UUID
  summary: PersonMergeSummary
}

export interface RelationshipMergeConflict {
  key: string
  left: Relationship
  right: Relationship
  fields: RelationshipMergeField[]
}

export interface PersonMergeDependencyConstraints {
  forcedCitationIds: UUID[]
  forcedAttachmentLinkIds: UUID[]
  relationshipReplacementIds: Record<UUID, UUID>
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function selectedKnown<T>(keep: T, remove: T, unknown: T, side: PersonMergeSide | undefined): T {
  if (side === 'remove') return clone(remove)
  if (side === 'keep') return clone(keep)
  return clone(keep === unknown && remove !== unknown ? remove : keep)
}

function selectedOptional<T>(keep: T | undefined, remove: T | undefined, side: PersonMergeSide | undefined): T | undefined {
  const value = side === 'remove' ? remove : side === 'keep' ? keep : keep ?? remove
  return value === undefined ? undefined : clone(value)
}

function selectedText(keep: string, remove: string, side: PersonMergeSide | undefined): string {
  return side === 'remove' ? remove : side === 'keep' ? keep : keep || remove
}

const PERSON_CONFLICT_FIELDS = [
  'sex', 'status', 'avatarUrl', 'birth', 'death', 'birthPlaceId', 'deathPlaceId', 'biography', 'notes',
] as const
type PersonConflictField = typeof PERSON_CONFLICT_FIELDS[number]

function meaningfulPersonValue(person: Person, field: PersonConflictField): unknown {
  const value = person[field]
  if ((field === 'sex' || field === 'status') && value === 'unknown') return undefined
  if ((field === 'birth' || field === 'death')
    && (value as Person['birth'])?.precision === 'unknown') return undefined
  if (typeof value === 'string' && !value.trim()) return undefined
  return value
}

function assertPersonConflictChoices(keep: Person, remove: Person, choices: PersonMergeChoices): void {
  for (const field of PERSON_CONFLICT_FIELDS) {
    const left = meaningfulPersonValue(keep, field)
    const right = meaningfulPersonValue(remove, field)
    const conflict = left !== undefined && right !== undefined && JSON.stringify(left) !== JSON.stringify(right)
    if (conflict && choices[field] !== 'keep' && choices[field] !== 'remove') {
      throw new Error(`Person merge requires an explicit choice for conflicting field: ${field}`)
    }
  }
}

function distinctNames(keep: Person, remove: Person, retainedNameValues: string[] | undefined) {
  const requested = retainedNameValues ? new Set(retainedNameValues) : undefined
  const seen = new Set<string>()
  const names = [...keep.names, ...remove.names].filter((name) => {
    if (requested && !requested.has(name.value)) return false
    const key = name.value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map(clone)
  if (names.length === 0) throw new Error('Person merge must retain at least one name')
  const primaryIndex = Math.max(0, names.findIndex(({ primary }) => primary))
  return names.map((name, index) => ({ ...name, primary: index === primaryIndex }))
}

function distinctSources(keep: Person, remove: Person, retainedSourceIds: UUID[] | undefined): UUID[] {
  const available = [...new Set([...(keep.sourceIds ?? []), ...(remove.sourceIds ?? [])])]
  if (!retainedSourceIds) return available
  const requested = new Set(retainedSourceIds)
  return available.filter((id) => requested.has(id))
}

function mergeRelationshipDetails(kept: Relationship, duplicate: Relationship): Relationship {
  return {
    ...kept,
    start: kept.start ?? duplicate.start,
    end: kept.end ?? duplicate.end,
    placeId: kept.placeId ?? duplicate.placeId,
    notes: kept.notes || duplicate.notes,
    sourceIds: [...new Set([...(kept.sourceIds ?? []), ...(duplicate.sourceIds ?? [])])],
  }
}

function relationshipFieldValue(relationship: Relationship, field: RelationshipMergeField): unknown {
  const value = relationship[field]
  return field === 'notes' && !value ? undefined : value
}

function relationshipConflictFields(left: Relationship, right: Relationship): RelationshipMergeField[] {
  return (['start', 'end', 'placeId', 'notes'] as const).filter((field) => {
    const first = relationshipFieldValue(left, field)
    const second = relationshipFieldValue(right, field)
    return first !== undefined && second !== undefined && JSON.stringify(first) !== JSON.stringify(second)
  })
}

function findRelationshipChoice(
  choices: RelationshipConflictChoice[] | undefined,
  leftId: UUID,
  rightId: UUID,
): RelationshipConflictChoice | undefined {
  const ids = [leftId, rightId].sort()
  return choices?.find((choice) => [...choice.relationshipIds].sort().every((id, index) => id === ids[index]))
}

function resolveRelationshipDetails(
  kept: Relationship,
  duplicate: Relationship,
  choices: RelationshipConflictChoice[] | undefined,
  requireExplicitChoices: boolean,
  conflicts: RelationshipMergeConflict[],
): Relationship {
  const conflictFields = relationshipConflictFields(kept, duplicate)
  const ids = [kept.id, duplicate.id].sort()
  if (conflictFields.length) conflicts.push({
    key: ids.join('\0'),
    left: clone(kept),
    right: clone(duplicate),
    fields: conflictFields,
  })
  const resolution = findRelationshipChoice(choices, kept.id, duplicate.id)
  const unresolved = conflictFields.filter((field) => {
    const selectedId = resolution?.fields[field]
    return selectedId !== kept.id && selectedId !== duplicate.id
  })
  if (requireExplicitChoices && unresolved.length) {
    throw new Error(`Relationship merge requires explicit choices for ${ids[0]} / ${ids[1]}: ${unresolved.join(', ')}`)
  }
  const resolved = mergeRelationshipDetails(kept, duplicate)
  for (const field of conflictFields) {
    const selected = resolution?.fields[field] === duplicate.id ? duplicate : kept
    Object.assign(resolved, { [field]: clone(selected[field]) })
  }
  return resolved
}

function relationshipKey(relationship: Relationship): string {
  let from = relationship.fromPersonId
  let to = relationship.toPersonId
  if (relationship.category === 'partner' && from.localeCompare(to) > 0) [from, to] = [to, from]
  return `${relationship.category}\0${relationship.type}\0${from}\0${to}`
}

function rewiredRelationship(relationship: Relationship, keepPersonId: UUID, removePersonId: UUID): Relationship {
  const next = clone(relationship)
  if (next.fromPersonId === removePersonId) next.fromPersonId = keepPersonId
  if (next.toPersonId === removePersonId) next.toPersonId = keepPersonId
  return next
}

export function derivePersonMergeDependencyConstraints(
  context: Pick<PersonMergeContext, 'relationships' | 'citations' | 'attachmentLinks'>,
  input: PersonMergeInput,
): PersonMergeDependencyConstraints {
  const { keepPersonId, removePersonId, choices } = input
  const relatedRelationshipIds = new Set(context.relationships
    .filter(({ fromPersonId, toPersonId }) => [fromPersonId, toPersonId].includes(keepPersonId)
      || [fromPersonId, toPersonId].includes(removePersonId))
    .map(({ id }) => id))
  const selectedRelationshipIds = choices.retainedRelationshipIds
    ? new Set(choices.retainedRelationshipIds)
    : relatedRelationshipIds
  const retainedByKey = new Map<string, UUID>()
  for (const relationship of context.relationships) {
    if (relatedRelationshipIds.has(relationship.id) && !selectedRelationshipIds.has(relationship.id)) continue
    const rewired = rewiredRelationship(relationship, keepPersonId, removePersonId)
    if (rewired.fromPersonId === rewired.toPersonId) continue
    if (!retainedByKey.has(relationshipKey(rewired))) retainedByKey.set(relationshipKey(rewired), relationship.id)
  }

  const relationshipReplacementIds: Record<UUID, UUID> = {}
  const discardedUniqueRelationshipIds = new Set<UUID>()
  for (const relationship of context.relationships) {
    if (!relatedRelationshipIds.has(relationship.id) || selectedRelationshipIds.has(relationship.id)) continue
    const rewired = rewiredRelationship(relationship, keepPersonId, removePersonId)
    const equivalentId = rewired.fromPersonId === rewired.toPersonId
      ? undefined
      : retainedByKey.get(relationshipKey(rewired))
    if (equivalentId) relationshipReplacementIds[relationship.id] = equivalentId
    else discardedUniqueRelationshipIds.add(relationship.id)
  }

  const relatedCitationIds = new Set(context.citations.filter((citation) =>
    (citation.targetType === 'person' && [keepPersonId, removePersonId].includes(citation.targetId))
    || (citation.targetType === 'relationship' && relatedRelationshipIds.has(citation.targetId))).map(({ id }) => id))
  const selectedCitationIds = choices.retainedCitationIds
    ? new Set(choices.retainedCitationIds)
    : relatedCitationIds
  const forcedCitationIds = context.citations.filter((citation) =>
    citation.targetType === 'relationship' && discardedUniqueRelationshipIds.has(citation.targetId)).map(({ id }) => id)
  const forcedCitationSet = new Set(forcedCitationIds)
  const effectiveCitationIds = new Set([...selectedCitationIds].filter((id) => !forcedCitationSet.has(id)))
  const forcedAttachmentLinkIds = context.attachmentLinks.filter((link) =>
    (link.targetType === 'relationship' && discardedUniqueRelationshipIds.has(link.targetId))
    || (link.targetType === 'citation' && relatedCitationIds.has(link.targetId) && !effectiveCitationIds.has(link.targetId)))
    .map(({ id }) => id)

  return {
    forcedCitationIds: forcedCitationIds.sort(),
    forcedAttachmentLinkIds: forcedAttachmentLinkIds.sort(),
    relationshipReplacementIds,
  }
}

function rewireRelationships(
  relationships: Relationship[],
  keepPersonId: UUID,
  removePersonId: UUID,
  conflictChoices: RelationshipConflictChoice[] | undefined,
  requireExplicitChoices = true,
): {
  items: Relationship[]
  rewired: number
  removed: number
  targetMap: Map<UUID, { targetType: 'person' | 'relationship'; targetId: UUID }>
  conflicts: RelationshipMergeConflict[]
  affectedIds: Set<UUID>
} {
  const output: Relationship[] = []
  const byKey = new Map<string, number>()
  const changedByIndex = new Map<number, boolean>()
  const targetMap = new Map<UUID, { targetType: 'person' | 'relationship'; targetId: UUID }>()
  let rewired = 0
  const conflicts: RelationshipMergeConflict[] = []
  const affectedIds = new Set<UUID>()
  for (const original of relationships) {
    const next = clone(original)
    if (next.fromPersonId === removePersonId) next.fromPersonId = keepPersonId
    if (next.toPersonId === removePersonId) next.toPersonId = keepPersonId
    if (next.fromPersonId === next.toPersonId) {
      affectedIds.add(original.id)
      targetMap.set(original.id, { targetType: 'person', targetId: keepPersonId })
      continue
    }
    const changed = next.fromPersonId !== original.fromPersonId || next.toPersonId !== original.toPersonId
    if (changed) rewired += 1
    if (changed) affectedIds.add(original.id)
    const key = relationshipKey(next)
    const existingIndex = byKey.get(key)
    if (existingIndex !== undefined && (changed || changedByIndex.get(existingIndex))) {
      const existing = output[existingIndex]!
      output[existingIndex] = resolveRelationshipDetails(
        existing,
        next,
        conflictChoices,
        requireExplicitChoices,
        conflicts,
      )
      changedByIndex.set(existingIndex, true)
      affectedIds.add(existing.id)
      affectedIds.add(original.id)
      targetMap.set(original.id, { targetType: 'relationship', targetId: output[existingIndex]!.id })
      continue
    }
    if (!byKey.has(key)) byKey.set(key, output.length)
    output.push(next)
    changedByIndex.set(output.length - 1, changed)
    targetMap.set(original.id, { targetType: 'relationship', targetId: next.id })
  }
  return { items: output, rewired, removed: relationships.length - output.length, targetMap, conflicts, affectedIds }
}

export function collectRelationshipMergeConflicts(
  relationships: Relationship[],
  keepPersonId: UUID,
  removePersonId: UUID,
  choices: RelationshipConflictChoice[] = [],
): RelationshipMergeConflict[] {
  return rewireRelationships(
    relationships,
    keepPersonId,
    removePersonId,
    choices,
    false,
  ).conflicts
}

function rewireEvents(events: FamilyEvent[], keepPersonId: UUID, removePersonId: UUID) {
  let rewired = 0
  const items = events.map((event) => {
    if (!event.participantIds.includes(removePersonId)) return clone(event)
    rewired += 1
    return {
      ...clone(event),
      participantIds: [...new Set(event.participantIds.map((id) => id === removePersonId ? keepPersonId : id))],
    }
  })
  return { items, rewired }
}

function rewireTypedTargets<T extends Citation | AttachmentLink>(
  items: T[],
  keepPersonId: UUID,
  removePersonId: UUID,
  relationshipTargetMap: Map<UUID, { targetType: 'person' | 'relationship'; targetId: UUID }>,
): { items: T[]; rewired: number } {
  let rewired = 0
  const output = items.map((item) => {
    if (item.targetType === 'person' && item.targetId === removePersonId) {
      rewired += 1
      return { ...clone(item), targetId: keepPersonId }
    }
    if (item.targetType === 'relationship') {
      const target = relationshipTargetMap.get(item.targetId)
      if (target && (target.targetType !== item.targetType || target.targetId !== item.targetId)) {
        rewired += 1
        return { ...clone(item), ...target } as T
      }
    }
    return clone(item)
  })
  return { items: output, rewired }
}

export function createPersonMergePreview(
  context: PersonMergeContext,
  input: PersonMergeInput,
): PersonMergePreview {
  if (input.keepPersonId === input.removePersonId) throw new Error('Cannot merge a person into itself')
  const keep = context.people.find(({ id }) => id === input.keepPersonId)
  const remove = context.people.find(({ id }) => id === input.removePersonId)
  if (!keep || !remove) throw new Error('Both merge people must exist')
  if (keep.projectId !== remove.projectId) throw new Error('Merge people must belong to the same project')
  const choices = input.choices
  assertPersonConflictChoices(keep, remove, choices)
  const retainedNames = distinctNames(keep, remove, choices.retainedNameValues)
  const retainedPerson: Person = {
    ...clone(keep),
    names: retainedNames,
    sex: selectedKnown(keep.sex, remove.sex, 'unknown', choices.sex),
    status: selectedKnown(keep.status, remove.status, 'unknown', choices.status),
    avatarUrl: selectedOptional(keep.avatarUrl, remove.avatarUrl, choices.avatarUrl),
    birth: selectedOptional(keep.birth, remove.birth, choices.birth),
    death: selectedOptional(keep.death, remove.death, choices.death),
    birthPlaceId: selectedOptional(keep.birthPlaceId, remove.birthPlaceId, choices.birthPlaceId),
    deathPlaceId: selectedOptional(keep.deathPlaceId, remove.deathPlaceId, choices.deathPlaceId),
    biography: selectedText(keep.biography, remove.biography, choices.biography),
    notes: selectedText(keep.notes, remove.notes, choices.notes),
    sourceIds: distinctSources(keep, remove, choices.retainedSourceIds),
    updatedAt: keep.updatedAt.localeCompare(remove.updatedAt) >= 0 ? keep.updatedAt : remove.updatedAt,
  }
  const people = context.people
    .filter(({ id }) => id !== remove.id)
    .map((person) => person.id === keep.id ? clone(retainedPerson) : clone(person))
  const relatedRelationships = new Set(context.relationships
    .filter(({ fromPersonId, toPersonId }) => [fromPersonId, toPersonId].includes(keep.id) || [fromPersonId, toPersonId].includes(remove.id))
    .map(({ id }) => id))
  const retainedRelationshipIds = choices.retainedRelationshipIds && new Set(choices.retainedRelationshipIds)
  const discardedRelationshipIds = new Set<UUID>()
  const dependencyConstraints = derivePersonMergeDependencyConstraints(context, input)
  const relationshipInput = context.relationships.filter(({ id }) => {
    const retained = !relatedRelationships.has(id) || !retainedRelationshipIds || retainedRelationshipIds.has(id)
    if (!retained) discardedRelationshipIds.add(id)
    return retained
  })
  const relationships = rewireRelationships(
    relationshipInput,
    keep.id,
    remove.id,
    choices.relationshipConflictChoices,
  )
  for (const id of discardedRelationshipIds) {
    const replacementId = dependencyConstraints.relationshipReplacementIds[id]
    if (replacementId) relationships.targetMap.set(id, { targetType: 'relationship', targetId: replacementId })
    relationships.affectedIds.add(id)
  }

  const retainedEventIds = choices.retainedEventIds && new Set(choices.retainedEventIds)
  const eventInput = context.events.map((event) => {
    const associated = event.participantIds.includes(keep.id) || event.participantIds.includes(remove.id)
    if (!associated || !retainedEventIds || retainedEventIds.has(event.id)) return event
    return { ...clone(event), participantIds: event.participantIds.filter((id) => id !== keep.id && id !== remove.id) }
  })
  const events = rewireEvents(eventInput, keep.id, remove.id)

  const relatedCitationIds = new Set(context.citations.filter((citation) =>
    (citation.targetType === 'person' && [keep.id, remove.id].includes(citation.targetId))
    || (citation.targetType === 'relationship' && relatedRelationships.has(citation.targetId))).map(({ id }) => id))
  const retainedCitationIds = choices.retainedCitationIds && new Set(choices.retainedCitationIds)
  const forcedCitationIds = new Set(dependencyConstraints.forcedCitationIds)
  const citationInput = context.citations.filter(({ id }) =>
    !forcedCitationIds.has(id)
    && (!relatedCitationIds.has(id) || !retainedCitationIds || retainedCitationIds.has(id)))
  const citations = rewireTypedTargets(citationInput, keep.id, remove.id, relationships.targetMap)

  const retainedCitationIdSet = new Set(citationInput.map(({ id }) => id))
  const relatedAttachmentLinkIds = new Set(context.attachmentLinks.filter((link) =>
    (link.targetType === 'person' && [keep.id, remove.id].includes(link.targetId))
    || (link.targetType === 'relationship' && relatedRelationships.has(link.targetId))
    || (link.targetType === 'citation' && relatedCitationIds.has(link.targetId))).map(({ id }) => id))
  const retainedAttachmentLinkIds = choices.retainedAttachmentLinkIds && new Set(choices.retainedAttachmentLinkIds)
  const forcedAttachmentLinkIds = new Set(dependencyConstraints.forcedAttachmentLinkIds)
  const retainedAttachmentLinkInput = context.attachmentLinks.filter((link) => {
    if (forcedAttachmentLinkIds.has(link.id)) return false
    if (link.targetType === 'citation' && !retainedCitationIdSet.has(link.targetId)) return false
    return !relatedAttachmentLinkIds.has(link.id)
      || !retainedAttachmentLinkIds
      || retainedAttachmentLinkIds.has(link.id)
  })
  const keepAvatarLink = retainedAttachmentLinkInput.find((link) =>
    link.targetType === 'person' && link.targetId === keep.id && link.role === 'avatar')
  const removeAvatarLink = retainedAttachmentLinkInput.find((link) =>
    link.targetType === 'person' && link.targetId === remove.id && link.role === 'avatar')
  const selectedAvatarLinkId = keepAvatarLink && removeAvatarLink
    ? choices.avatarUrl === 'remove' ? removeAvatarLink.id : keepAvatarLink.id
    : keepAvatarLink?.id ?? removeAvatarLink?.id
  const attachmentLinkInput = retainedAttachmentLinkInput.filter((link) =>
    link.role !== 'avatar'
    || link.targetType !== 'person'
    || ![keep.id, remove.id].includes(link.targetId)
    || link.id === selectedAvatarLinkId)
  const attachmentLinks = rewireTypedTargets(attachmentLinkInput, keep.id, remove.id, relationships.targetMap)
  const issues = (context.issues ?? [])
    .filter((issue) => {
      if (issue.targetType === 'person' && issue.targetId === remove.id) return false
      if (issue.targetType === 'relationship') {
        if (relationships.affectedIds.has(issue.targetId)) return false
        const target = relationships.targetMap.get(issue.targetId)
        if (target && (target.targetType !== 'relationship' || target.targetId !== issue.targetId)) return false
      }
      return true
    })
    .map(clone)

  return {
    people,
    relationships: relationships.items,
    events: events.items,
    citations: citations.items,
    attachmentLinks: attachmentLinks.items,
    issues,
    retainedPerson,
    removedPersonId: remove.id,
    summary: {
      removedPeople: 1,
      rewiredRelationships: relationships.rewired,
      removedRelationships: relationships.removed + discardedRelationshipIds.size,
      rewiredEvents: events.rewired,
      rewiredCitations: citations.rewired,
      rewiredAttachmentLinks: attachmentLinks.rewired,
    },
  }
}
