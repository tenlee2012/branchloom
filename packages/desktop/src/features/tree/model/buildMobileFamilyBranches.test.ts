import { describe, expect, it } from 'vitest'
import { createDemoState } from '../../../shared/fixtures/demoState'
import type { BoundedFamilySlice, ParentRelationship } from '../../../shared/domain/types'
import { buildMobileFamilyBranches } from './buildMobileFamilyBranches'

function demoSlice(): BoundedFamilySlice {
  const state = createDemoState()
  return {
    projectId: 'project-demo-family',
    centerPersonId: 'person-lin-hai',
    people: state.people,
    relationships: state.relationships,
    places: state.places,
    truncated: false,
    limits: { maxNodes: 200, maxEdges: 600, returnedNodes: 10, returnedEdges: 10 },
  }
}

describe('buildMobileFamilyBranches', () => {
  it('organizes direct relatives around the current center person', () => {
    const branches = buildMobileFamilyBranches(demoSlice(), 'person-lin-hai')
    const byKey = new Map(branches.map((branch) => [branch.key, branch]))

    expect(byKey.get('parents')?.items.map(({ person }) => person.id))
      .toEqual(['person-lin-guoqiang', 'person-zhou-suqin'])
    expect(byKey.get('partners')?.items.map(({ person }) => person.id))
      .toEqual(['person-chen-fang'])
    expect(byKey.get('children')?.items.map(({ person }) => person.id))
      .toEqual(['person-lin-chen', 'person-lin-xue'])
  })

  it('deduplicates siblings that share more than one recorded parent', () => {
    const branches = buildMobileFamilyBranches(demoSlice(), 'person-lin-chen')
    const siblings = branches.find(({ key }) => key === 'siblings')

    expect(siblings?.items.map(({ person }) => person.id))
      .toEqual(['person-lin-xue'])
  })

  it('keeps unconventional self relationships representable', () => {
    const slice = demoSlice()
    const selfRelationship: ParentRelationship = {
      id: 'relationship-self',
      projectId: slice.projectId,
      fromPersonId: 'person-lin-hai',
      toPersonId: 'person-lin-hai',
      category: 'parent',
      type: 'guardian',
      notes: '',
      sourceIds: [],
    }
    slice.relationships.push(selfRelationship)
    const branches = buildMobileFamilyBranches(slice, 'person-lin-hai')

    expect(branches.find(({ key }) => key === 'parents')?.items)
      .toContainEqual(expect.objectContaining({ relationship: selfRelationship }))
    expect(branches.find(({ key }) => key === 'children')?.items)
      .toContainEqual(expect.objectContaining({ relationship: selfRelationship }))
  })
})
