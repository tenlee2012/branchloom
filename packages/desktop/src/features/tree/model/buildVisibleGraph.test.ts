import { describe, expect, it } from 'vitest'
import type { Person, PrototypeState, Relationship } from '../../../shared/domain/types'
import { createDemoState } from '../../../shared/fixtures/demoState'
import { buildVisibleGraph, type VisibleGraphOptions } from './buildVisibleGraph'

function options(patch: Partial<VisibleGraphOptions> = {}): VisibleGraphOptions {
  return {
    centerPersonId: 'person-lin-hai',
    mode: 'combined',
    generationsUp: 2,
    generationsDown: 2,
    collapsedPersonIds: new Set(),
    ...patch,
  }
}

function ids(graph: ReturnType<typeof buildVisibleGraph>) {
  return graph.nodes.map(({ id }) => id)
}

describe('buildVisibleGraph', () => {
  it('preserves the tree workspace eight-generation traversal beyond print limits', () => {
    const people: Person[] = Array.from({ length: 9 }, (_, generation) => ({
      id: `eight-generation-${generation}`,
      projectId: 'eight-generation-project',
      names: [{ value: `第 ${generation} 代`, type: 'personal', primary: true }],
      sex: 'unknown', status: 'unknown', biography: '', notes: '', sourceIds: [], updatedAt: '2030-01-01',
    }))
    const relationships: Relationship[] = Array.from({ length: 8 }, (_, generation) => ({
      id: `eight-generation-relationship-${generation}`,
      projectId: 'eight-generation-project',
      category: 'parent', type: 'biological',
      fromPersonId: people[generation]!.id,
      toPersonId: people[generation + 1]!.id,
      notes: '', sourceIds: [],
    }))
    const state: PrototypeState = {
      schemaVersion: 2, projects: [], people, organizations: [], careers: [], personTitles: [],
      relationships, events: [], places: [], sources: [],
      citations: [], attachments: [], attachmentLinks: [], snapshots: [], issues: [],
    }

    const graph = buildVisibleGraph(state, {
      centerPersonId: people[0]!.id,
      mode: 'descendants',
      generationsUp: 0,
      generationsDown: 8,
      collapsedPersonIds: new Set(),
    })
    expect(graph.nodes).toHaveLength(9)
    expect(graph.nodes.find(({ id }) => id === people[8]!.id)?.generation).toBe(8)
  })

  it('chooses identical shortest-path generations for every relationship permutation', () => {
    const state = createDemoState()
    const extra: Person = {
      id: 'person-mixed-path', projectId: 'project-demo-family',
      names: [{ value: '混合路径人物', type: 'personal', primary: true }],
      sex: 'unknown', status: 'unknown', biography: '', notes: '', sourceIds: [], updatedAt: '2030-01-01',
    }
    const downstream: Person = {
      id: 'person-mixed-downstream', projectId: 'project-demo-family',
      names: [{ value: '混合路径下游', type: 'personal', primary: true }],
      sex: 'unknown', status: 'unknown', biography: '', notes: '', sourceIds: [], updatedAt: '2030-01-01',
    }
    state.people.push(extra, downstream)
    state.relationships.push(
      {
        id: 'relationship-mixed-up', projectId: 'project-demo-family', category: 'parent', type: 'biological',
        fromPersonId: 'person-mixed-path', toPersonId: 'person-lin-guoqiang', notes: '', sourceIds: [],
      },
      {
        id: 'relationship-mixed-down', projectId: 'project-demo-family', category: 'parent', type: 'biological',
        fromPersonId: 'person-lin-chen', toPersonId: 'person-mixed-path', notes: '', sourceIds: [],
      },
      {
        id: 'relationship-mixed-downstream', projectId: 'project-demo-family', category: 'parent', type: 'biological',
        fromPersonId: 'person-mixed-path', toPersonId: 'person-mixed-downstream', notes: '', sourceIds: [],
      },
    )
    const permutations = [
      state.relationships,
      [...state.relationships].reverse(),
      [...state.relationships.slice(4), ...state.relationships.slice(0, 4)],
    ]
    const results = permutations.map((relationships) => buildVisibleGraph(
      { ...state, relationships },
      options({ generationsUp: 3, generationsDown: 3 }),
    ))
    const project = (graph: ReturnType<typeof buildVisibleGraph>) => ({
      nodes: graph.nodes.map(({ id, generation }) => ({ id, generation })),
      edges: graph.edges.map(({ id, source, target }) => ({ id, source, target })),
    })
    expect(results.map(project)).toEqual([project(results[0]!), project(results[0]!), project(results[0]!)])
    expect(results[0]!.nodes.find(({ id }) => id === extra.id)?.generation).toBe(-2)
    expect(results[0]!.nodes.find(({ id }) => id === downstream.id)?.generation).toBe(-1)
  })

  it('traverses descendants added from a direct partner without pulling partner-of-partner chains', () => {
    const state = createDemoState()
    state.people.push(
      {
        id: 'person-partner-child', projectId: 'project-demo-family',
        names: [{ value: '伴侣新增子女', type: 'personal', primary: true }],
        sex: 'unknown', status: 'unknown', biography: '', notes: '', sourceIds: [], updatedAt: '2030-01-01',
      },
      {
        id: 'person-partner-chain', projectId: 'project-demo-family',
        names: [{ value: '伴侣的其他伴侣', type: 'personal', primary: true }],
        sex: 'unknown', status: 'unknown', biography: '', notes: '', sourceIds: [], updatedAt: '2030-01-01',
      },
    )
    state.relationships.push(
      {
        id: 'relationship-fang-new-child', projectId: 'project-demo-family', category: 'parent', type: 'biological',
        fromPersonId: 'person-chen-fang', toPersonId: 'person-partner-child', notes: '', sourceIds: [],
      },
      {
        id: 'relationship-fang-other-partner', projectId: 'project-demo-family', category: 'partner', type: 'partner',
        fromPersonId: 'person-chen-fang', toPersonId: 'person-partner-chain', notes: '', sourceIds: [],
      },
    )
    const graph = buildVisibleGraph(state, options({
      mode: 'descendants', generationsUp: 0, generationsDown: 1,
    }))
    expect(ids(graph)).toContain('person-partner-child')
    expect(graph.nodes.find(({ id }) => id === 'person-partner-child')?.generation).toBe(1)
    expect(ids(graph)).not.toContain('person-partner-chain')
  })

  it('keeps a combined partner branch downward-only across relationship permutations', () => {
    const person = (id: string): Person => ({
      id, projectId: 'project', names: [{ value: id, type: 'personal', primary: true }],
      sex: 'unknown', status: 'unknown', biography: '', notes: '', sourceIds: [], updatedAt: '2030-01-01',
    })
    const people = ['center', 'partner-p', 'child-c', 'grandchild-gc', 'parent-gp', 'partner-q'].map(person)
    const relationships: Relationship[] = [
      { id: 'r-center-p', projectId: 'project', category: 'partner', type: 'partner', fromPersonId: 'center', toPersonId: 'partner-p', notes: '', sourceIds: [] },
      { id: 'r-p-c', projectId: 'project', category: 'parent', type: 'biological', fromPersonId: 'partner-p', toPersonId: 'child-c', notes: '', sourceIds: [] },
      { id: 'r-c-gc', projectId: 'project', category: 'parent', type: 'biological', fromPersonId: 'child-c', toPersonId: 'grandchild-gc', notes: '', sourceIds: [] },
      { id: 'r-gp-p', projectId: 'project', category: 'parent', type: 'biological', fromPersonId: 'parent-gp', toPersonId: 'partner-p', notes: '', sourceIds: [] },
      { id: 'r-p-q', projectId: 'project', category: 'partner', type: 'partner', fromPersonId: 'partner-p', toPersonId: 'partner-q', notes: '', sourceIds: [] },
    ]
    const base: PrototypeState = {
      schemaVersion: 2, projects: [], people, organizations: [], careers: [], personTitles: [],
      relationships, events: [], places: [], sources: [], citations: [],
      attachments: [], attachmentLinks: [], snapshots: [], issues: [],
    }
    const permutations = [relationships, [...relationships].reverse(), [relationships[2]!, relationships[4]!, relationships[0]!, relationships[3]!, relationships[1]!]]
    const results = permutations.map((permutation) => buildVisibleGraph(
      { ...base, relationships: permutation },
      {
        centerPersonId: 'center', mode: 'combined', generationsUp: 2, generationsDown: 2,
        collapsedPersonIds: new Set(),
      },
    ))
    const projections = results.map((graph) => graph.nodes.map(({ id, generation }) => [id, generation]))
    expect(projections).toEqual([projections[0], projections[0], projections[0]])
    expect(ids(results[0]!)).toEqual(['center', 'partner-p', 'child-c', 'grandchild-gc'])
    expect(results[0]!.nodes.find(({ id }) => id === 'child-c')?.generation).toBe(1)
    expect(results[0]!.nodes.find(({ id }) => id === 'grandchild-gc')?.generation).toBe(2)
    expect(ids(results[0]!)).not.toContain('parent-gp')
    expect(ids(results[0]!)).not.toContain('partner-q')
  })

  it('builds a deterministic combined graph with generations and partners', () => {
    const graph = buildVisibleGraph(createDemoState(), options())

    expect(graph.status).toBe('ready')
    expect(graph.nodes.map(({ id, generation }) => [id, generation])).toEqual([
      ['person-lin-guoqiang', -1],
      ['person-wang-meilan', -1],
      ['person-zhou-suqin', -1],
      ['person-chen-fang', 0],
      ['person-lin-hai', 0],
      ['person-liu-ming', 0],
      ['person-xu-an', 0],
      ['person-lin-chen', 1],
      ['person-lin-xue', 1],
      ['person-zhao-wen', 1],
      ['person-lin-yu', 2],
    ])
    expect(graph.edges.map(({ id }) => id)).toEqual([...graph.edges.map(({ id }) => id)].sort())
  })

  it('does not include people beyond the ancestor generation limit', () => {
    const graph = buildVisibleGraph(createDemoState(), options({
      mode: 'ancestors',
      generationsUp: 1,
      generationsDown: 0,
    }))
    expect(graph.nodes.every((node) => node.generation >= -1 && node.generation <= 0)).toBe(true)
    expect(ids(graph)).toContain('person-lin-guoqiang')
    expect(ids(graph)).not.toContain('person-lin-chen')
  })

  it('limits descendant traversal and includes partners at their family generation', () => {
    const graph = buildVisibleGraph(createDemoState(), options({
      mode: 'descendants',
      generationsUp: 0,
      generationsDown: 1,
    }))
    expect(ids(graph)).toEqual([
      'person-chen-fang',
      'person-lin-hai',
      'person-lin-chen',
      'person-lin-xue',
      'person-zhao-wen',
    ])
    expect(ids(graph)).not.toContain('person-lin-yu')
  })

  it('stops traversal beyond a collapsed person while retaining that person', () => {
    const graph = buildVisibleGraph(createDemoState(), options({
      centerPersonId: 'person-lin-guoqiang',
      generationsUp: 0,
      generationsDown: 3,
      collapsedPersonIds: new Set(['person-lin-hai']),
    }))
    expect(ids(graph)).toContain('person-lin-hai')
    expect(ids(graph)).not.toContain('person-lin-chen')
    expect(ids(graph)).not.toContain('person-lin-xue')
  })

  it('recomputes generations when the center person changes', () => {
    const graph = buildVisibleGraph(createDemoState(), options({ centerPersonId: 'person-lin-chen' }))
    expect(graph.nodes.find(({ id }) => id === 'person-lin-chen')?.generation).toBe(0)
    expect(graph.nodes.find(({ id }) => id === 'person-lin-hai')?.generation).toBe(-1)
    expect(graph.nodes.find(({ id }) => id === 'person-lin-yu')?.generation).toBe(1)
  })

  it('returns a missing-center empty state for absent and soft-deleted people', () => {
    const absent = buildVisibleGraph(createDemoState(), options({ centerPersonId: 'absent' }))
    const deletedState = createDemoState()
    deletedState.people.find(({ id }) => id === 'person-lin-hai')!.deletedAt = '2030-01-01T00:00:00.000Z'
    const deleted = buildVisibleGraph(deletedState, options())
    expect(absent).toMatchObject({ status: 'missing-center', nodes: [], edges: [] })
    expect(deleted).toMatchObject({ status: 'missing-center', nodes: [], edges: [] })
  })

  it('raises the hard warning when the bounded graph exceeds the configured threshold', () => {
    const graph = buildVisibleGraph(createDemoState(), options({ warningThreshold: 4 }))
    expect(graph.thresholdExceeded).toBe(true)
    expect(graph.nodes.length).toBeGreaterThan(4)
    expect(graph.warningThreshold).toBe(4)
  })

  it('maps every supported relationship type to a localized label and intentional line style', () => {
    const people: Person[] = Array.from({ length: 11 }, (_, index) => ({
      id: `p${index}`,
      projectId: 'project',
      names: [{ value: `人物${index}`, type: 'personal', primary: true }],
      sex: 'unknown', status: 'unknown', biography: '', notes: '', sourceIds: [], updatedAt: '2030-01-01',
    }))
    const relationshipKinds = [
      ['parent', 'biological'], ['parent', 'adoptive'], ['parent', 'step'], ['parent', 'guardian'],
      ['partner', 'engaged'], ['partner', 'married'], ['partner', 'partner'], ['partner', 'separated'], ['partner', 'divorced'],
    ] as const
    const relationships = relationshipKinds.map(([category, type], index) => ({
      id: `r-${type}`, projectId: 'project', category, type,
      fromPersonId: 'p0', toPersonId: `p${index + 1}`, notes: '', sourceIds: [],
    })) as Relationship[]
    const state: PrototypeState = {
      schemaVersion: 2, projects: [], people, organizations: [], careers: [], personTitles: [],
      relationships, events: [], places: [], sources: [],
      citations: [], attachments: [], attachmentLinks: [], snapshots: [], issues: [],
    }
    const graph = buildVisibleGraph(state, {
      ...options(), centerPersonId: 'p0', generationsUp: 1, generationsDown: 1,
    })
    expect(Object.fromEntries(graph.edges.map((edge) => [edge.id, [edge.label, edge.lineStyle]]))).toEqual({
      'r-adoptive': ['收养', 'dashed'],
      'r-biological': ['亲生', 'solid'],
      'r-divorced': ['离异', 'dotted'],
      'r-engaged': ['订婚', 'dotted'],
      'r-guardian': ['监护', 'dashed'],
      'r-married': ['婚姻', 'solid'],
      'r-partner': ['事实伴侣', 'dashed'],
      'r-separated': ['分居', 'dashed'],
      'r-step': ['继亲', 'dotted'],
    })
  })
})
