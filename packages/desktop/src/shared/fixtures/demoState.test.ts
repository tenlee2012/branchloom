import { describe, expect, it } from 'vitest'
import type { PrototypeState, Relationship } from '../domain/types'
import { createDemoState } from './demoState'

const expectedCounts = {
  projects: 1,
  people: 12,
  relationships: 13,
  events: 8,
  sources: 5,
  citations: 6,
  attachments: 4,
  attachmentLinks: 6,
  snapshots: 3,
}

function hasParentPath(
  relationships: Relationship[],
  path: string[],
): boolean {
  return path.slice(0, -1).every((fromPersonId, index) =>
    relationships.some(
      (relationship) =>
        relationship.category === 'parent' &&
        relationship.fromPersonId === fromPersonId &&
        relationship.toPersonId === path[index + 1],
    ),
  )
}

function expectReferencesToExist(state: PrototypeState) {
  const projectIds = new Set(state.projects.map(({ id }) => id))
  const peopleIds = new Set(state.people.map(({ id }) => id))
  const placeIds = new Set(state.places.map(({ id }) => id))
  const sourceIds = new Set(state.sources.map(({ id }) => id))
  const relationshipIds = new Set(state.relationships.map(({ id }) => id))
  const eventIds = new Set(state.events.map(({ id }) => id))
  const citationIds = new Set(state.citations.map(({ id }) => id))
  const attachmentIds = new Set(state.attachments.map(({ id }) => id))

  for (const project of state.projects) {
    if (project.defaultPersonId) expect(peopleIds.has(project.defaultPersonId)).toBe(true)
  }
  for (const place of state.places) {
    expect(projectIds.has(place.projectId)).toBe(true)
    if (place.parentId) expect(placeIds.has(place.parentId)).toBe(true)
  }
  for (const person of state.people) {
    expect(projectIds.has(person.projectId)).toBe(true)
    if (person.birthPlaceId) expect(placeIds.has(person.birthPlaceId)).toBe(true)
    if (person.deathPlaceId) expect(placeIds.has(person.deathPlaceId)).toBe(true)
    person.sourceIds?.forEach((id) => expect(sourceIds.has(id)).toBe(true))
  }
  for (const relationship of state.relationships) {
    expect(projectIds.has(relationship.projectId)).toBe(true)
    expect(peopleIds.has(relationship.fromPersonId)).toBe(true)
    expect(peopleIds.has(relationship.toPersonId)).toBe(true)
    if (relationship.placeId) expect(placeIds.has(relationship.placeId)).toBe(true)
    relationship.sourceIds.forEach((id) => expect(sourceIds.has(id)).toBe(true))
  }
  for (const event of state.events) {
    expect(projectIds.has(event.projectId)).toBe(true)
    if (event.placeId) expect(placeIds.has(event.placeId)).toBe(true)
    event.participantIds.forEach((id) => expect(peopleIds.has(id)).toBe(true))
    event.sourceIds.forEach((id) => expect(sourceIds.has(id)).toBe(true))
  }
  for (const source of state.sources) expect(projectIds.has(source.projectId)).toBe(true)
  for (const citation of state.citations) {
    expect(projectIds.has(citation.projectId)).toBe(true)
    expect(sourceIds.has(citation.sourceId)).toBe(true)
    const targets =
      citation.targetType === 'person'
        ? peopleIds
        : citation.targetType === 'relationship'
          ? relationshipIds
          : eventIds
    expect(targets.has(citation.targetId)).toBe(true)
  }
  for (const attachment of state.attachments) {
    expect(projectIds.has(attachment.projectId)).toBe(true)
  }
  for (const link of state.attachmentLinks) {
    expect(projectIds.has(link.projectId)).toBe(true)
    expect(attachmentIds.has(link.attachmentId)).toBe(true)
    const targets =
      link.targetType === 'person'
        ? peopleIds
        : link.targetType === 'relationship'
          ? relationshipIds
          : link.targetType === 'event'
            ? eventIds
            : citationIds
    expect(targets.has(link.targetId)).toBe(true)
  }
  for (const snapshot of state.snapshots) expect(projectIds.has(snapshot.projectId)).toBe(true)
  for (const issue of state.issues) {
    const targets =
      issue.targetType === 'person'
        ? peopleIds
        : issue.targetType === 'relationship'
          ? relationshipIds
          : issue.targetType === 'event'
            ? eventIds
            : issue.targetType === 'source'
              ? sourceIds
              : attachmentIds
    expect(targets.has(issue.targetId)).toBe(true)
  }
}

describe('createDemoState', () => {
  it('returns deterministic, deeply independent state', () => {
    const first = createDemoState()
    const second = createDemoState()

    expect(first).toEqual(second)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(first).not.toBe(second)
    expect(first.people).not.toBe(second.people)

    first.projects[0]!.name = '已修改的本地副本'
    first.people[0]!.names[0]!.value = '已修改姓名'
    expect(second.projects[0]!.name).not.toBe('已修改的本地副本')
    expect(second.people[0]!.names[0]!.value).not.toBe('已修改姓名')
  })

  it('contains the exact phase-one fixture cardinalities', () => {
    const state = createDemoState()

    for (const [collection, count] of Object.entries(expectedCounts)) {
      expect(state[collection as keyof typeof expectedCounts]).toHaveLength(count)
    }
  })

  it('spans four generations and exercises relationship variants', () => {
    const state = createDemoState()
    const parentTypes = new Set(
      state.relationships
        .filter(({ category }) => category === 'parent')
        .map(({ type }) => type),
    )
    const partnerTypes = new Set(
      state.relationships
        .filter(({ category }) => category === 'partner')
        .map(({ type }) => type),
    )

    expect(
      hasParentPath(state.relationships, [
        'person-lin-guoqiang',
        'person-lin-hai',
        'person-lin-chen',
        'person-lin-yu',
      ]),
    ).toBe(true)
    expect(parentTypes).toEqual(new Set(['biological', 'adoptive', 'step', 'guardian']))
    expect(partnerTypes).toEqual(new Set(['married', 'divorced', 'partner']))
  })

  it('offers rich names, date precision, places, evidence and known issue samples', () => {
    const state = createDemoState()
    const allPrecisions = new Set([
      ...state.people.flatMap(({ birth, death }) => [birth?.precision, death?.precision]),
      ...state.events.map(({ date }) => date.precision),
    ])
    const duplicateCandidates = state.people.filter(
      ({ names }) => names.some(({ value }) => value === '林晨'),
    )

    expect(state.people.some(({ names }) => names.length > 1)).toBe(true)
    expect(allPrecisions.size).toBeGreaterThanOrEqual(5)
    expect(state.places.length).toBeGreaterThanOrEqual(5)
    expect(state.events.every(({ participantIds }) => participantIds.length > 0)).toBe(true)
    expect(new Set(state.sources.map(({ type }) => type)).size).toBeGreaterThanOrEqual(4)
    expect(duplicateCandidates).toHaveLength(2)
    expect(duplicateCandidates.every(({ birth }) => birth?.display.includes('1988'))).toBe(true)
    expect(state.attachments.some(({ missing }) => missing)).toBe(true)
    expect(state.relationships.some(({ placeId }) => Boolean(placeId))).toBe(true)
    expect(state.places.every(({ notes }) => typeof notes === 'string')).toBe(true)
    expect(state.sources.some(({ date, referenceCode }) => date && referenceCode)).toBe(true)
    expect(state.citations.every(({ notes }) => typeof notes === 'string')).toBe(true)
    expect(state.attachments.every(({ contentHash }) => contentHash.length > 0)).toBe(true)
    expect(state.attachments.map(({ contentHash }) => contentHash)).toEqual([
      '16899059cd934d04216bab163bb68e887e2bb9a5065e66d8be2fdeafb00694c1',
      'da0c613c913a52e4be4479c3757ca00257d7a0beed6e93c08bfe67b661a02539',
      '4e47845db280c0954dd594fa393cd5c14ee0a815288e061b0a31e1a4817a49df',
      'c8989a82a0265e0ee015ccb0f3189086fe0af17d2d134ee4eb0d9553f7a653ee',
    ])
    expect(state.issues.some(({ targetType }) => targetType === 'attachment')).toBe(true)
    expect(
      state.sources.some(
        ({ id }) =>
          !state.citations.some(({ sourceId }) => sourceId === id) &&
          !state.people.some(({ sourceIds }) => (sourceIds ?? []).includes(id)) &&
          !state.relationships.some(({ sourceIds }) => sourceIds.includes(id)) &&
          !state.events.some(({ sourceIds }) => sourceIds.includes(id)),
      ),
    ).toBe(true)
  })

  it('normalizes reusable attachment links across every supported target type', () => {
    const state = createDemoState()
    const targetTypes = new Set(state.attachmentLinks.map(({ targetType }) => targetType))
    const targetsByAttachment = new Map<string, number>()
    for (const link of state.attachmentLinks) {
      targetsByAttachment.set(link.attachmentId, (targetsByAttachment.get(link.attachmentId) ?? 0) + 1)
    }

    expect(state.attachmentLinks).toHaveLength(6)
    expect(targetTypes).toEqual(new Set(['person', 'relationship', 'event', 'citation']))
    expect([...targetsByAttachment.values()].some((count) => count > 1)).toBe(true)
  })

  it('keeps every declared foreign key internally valid', () => {
    expectReferencesToExist(createDemoState())
  })
})
