import type { Person, Relationship, UUID } from './types'

export type FamilyTreeMode = 'ancestors' | 'descendants' | 'combined'

export const FAMILY_GRAPH_LIMITS = Object.freeze({ maxNodes: 500, maxEdges: 1_000 })

export interface FamilyGraphTraversalOptions {
  projectId: UUID
  centerPersonId: UUID
  mode: FamilyTreeMode
  generationsUp: number
  generationsDown: number
  collapsedPersonIds: ReadonlySet<UUID>
  maxNodes?: number
  maxEdges?: number
}

export interface FamilyGraphTraversalNode {
  personId: UUID
  generation: number
  person: Person
}

export interface FamilyGraphTraversalResult {
  status: 'ready' | 'missing-center'
  nodes: FamilyGraphTraversalNode[]
  relationshipIds: UUID[]
  relationships: Relationship[]
  truncated: boolean
  limits: {
    maxNodes: number
    maxEdges: number
    returnedNodes: number
    returnedEdges: number
  }
}

type TraversalRole = 'lineage' | 'partner-branch'

interface TraversalCandidate {
  personId: UUID
  generation: number
  distance: number
  role: TraversalRole
  pathKey: string
}

function compareCandidates(left: TraversalCandidate, right: TraversalCandidate): number {
  return left.distance - right.distance
    || Math.abs(left.generation) - Math.abs(right.generation)
    || left.generation - right.generation
    || left.pathKey.localeCompare(right.pathKey)
    || left.role.localeCompare(right.role)
    || left.personId.localeCompare(right.personId)
}

function stateKey(candidate: Pick<TraversalCandidate, 'personId' | 'role'>): string {
  return `${candidate.role}:${candidate.personId}`
}

function relationshipOrder(left: Relationship, right: Relationship): number {
  return left.id.localeCompare(right.id)
    || left.fromPersonId.localeCompare(right.fromPersonId)
    || left.toPersonId.localeCompare(right.toPersonId)
}

function append(map: Map<UUID, Relationship[]>, personId: UUID, relationship: Relationship) {
  const entries = map.get(personId)
  if (entries) entries.push(relationship)
  else map.set(personId, [relationship])
}

function normalizeTraversalDepth(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

/**
 * Deterministic bounded traversal shared by repository slices and presentation graphs.
 * Source people and relationships are each consumed once; traversal uses indexed adjacency lists.
 */
export function traverseFamilyGraph(
  peopleSource: Iterable<Person>,
  relationshipsSource: Iterable<Relationship>,
  options: FamilyGraphTraversalOptions,
): FamilyGraphTraversalResult {
  const maxNodes = Math.max(1, Math.floor(options.maxNodes ?? FAMILY_GRAPH_LIMITS.maxNodes))
  const maxEdges = Math.max(1, Math.floor(options.maxEdges ?? FAMILY_GRAPH_LIMITS.maxEdges))
  const generationsUp = normalizeTraversalDepth(options.generationsUp)
  const generationsDown = normalizeTraversalDepth(options.generationsDown)
  const people = new Map<UUID, Person>()
  for (const person of peopleSource) {
    if (person.projectId === options.projectId && !person.deletedAt) people.set(person.id, person)
  }
  if (!people.has(options.centerPersonId)) {
    return {
      status: 'missing-center', nodes: [], relationshipIds: [], relationships: [], truncated: false,
      limits: { maxNodes, maxEdges, returnedNodes: 0, returnedEdges: 0 },
    }
  }

  const relationships = new Map<UUID, Relationship>()
  const parentsByChild = new Map<UUID, Relationship[]>()
  const childrenByParent = new Map<UUID, Relationship[]>()
  const partnersByPerson = new Map<UUID, Relationship[]>()
  const relationshipsByPerson = new Map<UUID, Relationship[]>()
  for (const relationship of relationshipsSource) {
    if (relationship.projectId !== options.projectId
      || !people.has(relationship.fromPersonId)
      || !people.has(relationship.toPersonId)) continue
    relationships.set(relationship.id, relationship)
    append(relationshipsByPerson, relationship.fromPersonId, relationship)
    append(relationshipsByPerson, relationship.toPersonId, relationship)
    if (relationship.category === 'parent') {
      append(parentsByChild, relationship.toPersonId, relationship)
      append(childrenByParent, relationship.fromPersonId, relationship)
    } else {
      append(partnersByPerson, relationship.fromPersonId, relationship)
      append(partnersByPerson, relationship.toPersonId, relationship)
    }
  }
  for (const map of [parentsByChild, childrenByParent, partnersByPerson, relationshipsByPerson]) {
    for (const entries of map.values()) entries.sort(relationshipOrder)
  }

  const acceptedPeople = new Set<UUID>([options.centerPersonId])
  const bestByState = new Map<string, TraversalCandidate>()
  let truncated = false
  let frontier: TraversalCandidate[] = [{
    personId: options.centerPersonId,
    generation: 0,
    distance: 0,
    role: 'lineage',
    pathKey: options.centerPersonId,
  }]

  while (frontier.length > 0) {
    frontier.sort(compareCandidates)
    const nextByState = new Map<string, TraversalCandidate>()
    const offer = (candidate: TraversalCandidate) => {
      if (candidate.generation < -generationsUp || candidate.generation > generationsDown) return
      if (bestByState.has(stateKey(candidate))) return
      if (!acceptedPeople.has(candidate.personId)) {
        if (acceptedPeople.size >= maxNodes) { truncated = true; return }
        acceptedPeople.add(candidate.personId)
      }
      const key = stateKey(candidate)
      const current = nextByState.get(key)
      if (!current || compareCandidates(candidate, current) < 0) nextByState.set(key, candidate)
    }

    for (const candidate of frontier) {
      const key = stateKey(candidate)
      if (bestByState.has(key)) continue
      bestByState.set(key, candidate)
    }
    for (const candidate of frontier) {
      if (bestByState.get(stateKey(candidate)) !== candidate) continue
      if (options.collapsedPersonIds.has(candidate.personId)) continue
      if (candidate.role === 'lineage' && options.mode !== 'descendants') {
        for (const relationship of parentsByChild.get(candidate.personId) ?? []) {
          offer({
            personId: relationship.fromPersonId,
            generation: candidate.generation - 1,
            distance: candidate.distance + 1,
            role: 'lineage',
            pathKey: `${candidate.pathKey}/u:${relationship.id}:${relationship.fromPersonId}`,
          })
        }
      }
      if (options.mode !== 'ancestors') {
        for (const relationship of childrenByParent.get(candidate.personId) ?? []) {
          offer({
            personId: relationship.toPersonId,
            generation: candidate.generation + 1,
            distance: candidate.distance + 1,
            role: candidate.role,
            pathKey: `${candidate.pathKey}/d:${relationship.id}:${relationship.toPersonId}`,
          })
        }
      }
      if (candidate.role === 'lineage') {
        for (const relationship of partnersByPerson.get(candidate.personId) ?? []) {
          const partnerId = relationship.fromPersonId === candidate.personId
            ? relationship.toPersonId
            : relationship.fromPersonId
          offer({
            personId: partnerId,
            generation: candidate.generation,
            distance: candidate.distance + 1,
            role: 'partner-branch',
            pathKey: `${candidate.pathKey}/p:${relationship.id}:${partnerId}`,
          })
        }
      }
    }
    frontier = [...nextByState.values()]
  }

  const bestByPerson = new Map<UUID, TraversalCandidate>()
  for (const candidate of bestByState.values()) {
    const current = bestByPerson.get(candidate.personId)
    if (!current || compareCandidates(candidate, current) < 0) bestByPerson.set(candidate.personId, candidate)
  }
  const nodes = [...bestByPerson.values()]
    .map(({ personId, generation }) => ({ personId, generation, person: people.get(personId)! }))
    .sort((left, right) => left.generation - right.generation || left.personId.localeCompare(right.personId))
  const visibleIds = new Set(nodes.map(({ personId }) => personId))
  const relationshipIds = new Set<UUID>()
  for (const personId of [...visibleIds].sort()) {
    for (const relationship of relationshipsByPerson.get(personId) ?? []) {
      if (!visibleIds.has(relationship.fromPersonId) || !visibleIds.has(relationship.toPersonId)
        || relationshipIds.has(relationship.id)) continue
      if (relationshipIds.size >= maxEdges) { truncated = true; continue }
      relationshipIds.add(relationship.id)
    }
  }
  const stableRelationshipIds = [...relationshipIds].sort()
  const stableRelationships = stableRelationshipIds.map((id) => relationships.get(id)!)
  return {
    status: 'ready',
    nodes,
    relationshipIds: stableRelationshipIds,
    relationships: stableRelationships,
    truncated,
    limits: {
      maxNodes,
      maxEdges,
      returnedNodes: nodes.length,
      returnedEdges: stableRelationshipIds.length,
    },
  }
}
