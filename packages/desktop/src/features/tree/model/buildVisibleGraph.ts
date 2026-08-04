import type { Person, PrototypeState, Relationship } from '../../../shared/domain/types'
import { traverseFamilyGraph, type FamilyTreeMode } from '../../../shared/domain/familyGraph'
import { getPrimaryName } from '../../../shared/domain/personNames'

export type TreeMode = FamilyTreeMode

export interface VisibleGraphOptions {
  centerPersonId: string
  mode: TreeMode
  generationsUp: number
  generationsDown: number
  collapsedPersonIds: ReadonlySet<string>
  warningThreshold?: number
}

export interface VisibleGraph {
  status: 'ready' | 'missing-center'
  nodes: VisibleGraphNode[]
  edges: VisibleGraphEdge[]
  thresholdExceeded: boolean
  warningThreshold: number
  truncated?: boolean
  limits?: { maxNodes: number; maxEdges: number; returnedNodes: number; returnedEdges: number }
}

export interface VisibleGraphNode {
  id: string
  generation: number
  person: Person
  primaryName: string
  birthLabel: string
  deathLabel: string
  birthPlaceLabel: string
  collapsed: boolean
}

export interface VisibleGraphEdge {
  id: string
  source: string
  target: string
  label: string
  lineStyle: 'solid' | 'dashed' | 'dotted'
  category: Relationship['category']
  type: Relationship['type']
}

const relationshipPresentation: Record<Relationship['type'], { label: string; lineStyle: VisibleGraphEdge['lineStyle'] }> = {
  biological: { label: '亲生', lineStyle: 'solid' },
  adoptive: { label: '收养', lineStyle: 'dashed' },
  step: { label: '继亲', lineStyle: 'dotted' },
  guardian: { label: '监护', lineStyle: 'dashed' },
  engaged: { label: '订婚', lineStyle: 'dotted' },
  married: { label: '婚姻', lineStyle: 'solid' },
  partner: { label: '事实伴侣', lineStyle: 'dashed' },
  separated: { label: '分居', lineStyle: 'dashed' },
  divorced: { label: '离异', lineStyle: 'dotted' },
}

export function buildVisibleGraph(state: PrototypeState, options: VisibleGraphOptions): VisibleGraph {
  const warningThreshold = Math.max(1, Math.floor(options.warningThreshold ?? 80))
  const center = state.people.find(({ id, deletedAt }) => id === options.centerPersonId && !deletedAt)
  if (!center) {
    return {
      status: 'missing-center',
      nodes: [],
      edges: [],
      thresholdExceeded: false,
      warningThreshold,
    }
  }
  const traversal = traverseFamilyGraph(state.people, state.relationships, {
    projectId: center.projectId,
    centerPersonId: options.centerPersonId,
    mode: options.mode,
    generationsUp: options.generationsUp,
    generationsDown: options.generationsDown,
    collapsedPersonIds: options.collapsedPersonIds,
  })
  const placeNames = new Map(state.places.map(({ id, name }) => [id, name]))
  const nodes = traversal.nodes
    .map(({ personId: id, generation, person }): VisibleGraphNode => {
      return {
        id,
        generation,
        person,
        primaryName: getPrimaryName(person),
        birthLabel: person.birth?.display ?? '',
        deathLabel: person.death?.display ?? '',
        birthPlaceLabel: person.birthPlaceId ? placeNames.get(person.birthPlaceId) ?? '' : '',
        collapsed: options.collapsedPersonIds.has(id),
      }
    })
    .sort((left, right) => left.generation - right.generation
      || left.primaryName.localeCompare(right.primaryName, 'zh-CN')
      || left.id.localeCompare(right.id))
  const edges = traversal.relationships
    .map((relationship): VisibleGraphEdge => ({
      id: relationship.id,
      source: relationship.fromPersonId,
      target: relationship.toPersonId,
      category: relationship.category,
      type: relationship.type,
      ...relationshipPresentation[relationship.type],
    }))
    .sort((left, right) => left.id.localeCompare(right.id))

  return {
    status: 'ready',
    nodes,
    edges,
    thresholdExceeded: nodes.length > warningThreshold || traversal.truncated,
    warningThreshold,
    truncated: traversal.truncated,
    limits: traversal.limits,
  }
}
