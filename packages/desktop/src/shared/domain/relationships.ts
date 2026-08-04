import type {
  DataIssue,
  GenealogyDate,
  ParentRelation,
  ParentRelationship,
  PartnerRelation,
  Relationship,
} from './types'

const PARENT_RELATIONS = new Set<ParentRelation>(['biological', 'adoptive', 'step', 'guardian'])
const PARTNER_RELATIONS = new Set<PartnerRelation>([
  'engaged',
  'married',
  'partner',
  'separated',
  'divorced',
])
const LINEAGE_RELATIONS = new Set<ParentRelation>(['biological', 'adoptive'])
const DATE_PRECISIONS = new Set<GenealogyDate['precision']>([
  'exact',
  'about',
  'before',
  'after',
  'range',
  'unknown',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isGenealogyDate(value: unknown): value is GenealogyDate {
  if (!isRecord(value)) return false
  return (
    typeof value.display === 'string' &&
    typeof value.precision === 'string' &&
    DATE_PRECISIONS.has(value.precision as GenealogyDate['precision']) &&
    (value.start === undefined || typeof value.start === 'string') &&
    (value.end === undefined || typeof value.end === 'string')
  )
}

export function isRelationship(value: unknown): value is Relationship {
  if (!isRecord(value)) return false
  const hasValidBase =
    typeof value.id === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.fromPersonId === 'string' &&
    typeof value.toPersonId === 'string' &&
    typeof value.notes === 'string' &&
    Array.isArray(value.sourceIds) &&
    value.sourceIds.every((sourceId) => typeof sourceId === 'string') &&
    (value.start === undefined || isGenealogyDate(value.start)) &&
    (value.end === undefined || isGenealogyDate(value.end)) &&
    (value.placeId === undefined || typeof value.placeId === 'string')
  if (!hasValidBase || typeof value.type !== 'string') return false

  if (value.category === 'parent') return PARENT_RELATIONS.has(value.type as ParentRelation)
  if (value.category === 'partner') return PARTNER_RELATIONS.has(value.type as PartnerRelation)
  return false
}

function relationshipIssue(
  relationship: Relationship,
  severity: DataIssue['severity'],
  code: string,
  message: string,
): DataIssue {
  return {
    id: `issue-${relationship.id}-${code}`,
    severity,
    code,
    message,
    targetType: 'relationship',
    targetId: relationship.id,
  }
}

function isDuplicate(candidate: Relationship, existing: Relationship): boolean {
  if (candidate.id === existing.id || candidate.projectId !== existing.projectId) return false

  if (candidate.category === 'parent') {
    return (
      existing.category === 'parent' &&
      candidate.type === existing.type &&
      candidate.fromPersonId === existing.fromPersonId &&
      candidate.toPersonId === existing.toPersonId
    )
  }

  return (
    existing.category === 'partner' &&
    candidate.type === existing.type &&
    ((candidate.fromPersonId === existing.fromPersonId &&
      candidate.toPersonId === existing.toPersonId) ||
      (candidate.fromPersonId === existing.toPersonId &&
        candidate.toPersonId === existing.fromPersonId))
  )
}

function closesAncestorCycle(candidate: ParentRelationship, existing: Relationship[]): boolean {
  if (!LINEAGE_RELATIONS.has(candidate.type)) return false

  const childrenByParent = new Map<string, string[]>()
  for (const relationship of existing) {
    if (
      relationship.id === candidate.id ||
      relationship.projectId !== candidate.projectId ||
      relationship.category !== 'parent' ||
      !LINEAGE_RELATIONS.has(relationship.type)
    ) {
      continue
    }
    const children = childrenByParent.get(relationship.fromPersonId) ?? []
    children.push(relationship.toPersonId)
    childrenByParent.set(relationship.fromPersonId, children)
  }

  const pending = [candidate.toPersonId]
  const visited = new Set<string>()
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const personId = pending[cursor]!
    if (personId === candidate.fromPersonId) return true
    if (visited.has(personId)) continue
    visited.add(personId)
    pending.push(...(childrenByParent.get(personId) ?? []))
  }

  return false
}

export function validateRelationship(
  candidate: Relationship,
  existing: Relationship[],
): DataIssue | undefined {
  if (candidate.fromPersonId === candidate.toPersonId) {
    const isParent = candidate.category === 'parent'
    return relationshipIssue(
      candidate,
      'error',
      isParent ? 'self-parent' : 'self-partner',
      isParent ? '人物不能成为自己的父母或监护人。' : '人物不能成为自己的伴侣。',
    )
  }

  if (existing.some((relationship) => isDuplicate(candidate, relationship))) {
    return relationshipIssue(
      candidate,
      'warning',
      'duplicate-relationship',
      '已存在相同类型的人物关系。',
    )
  }

  if (candidate.category === 'parent' && closesAncestorCycle(candidate, existing)) {
    return relationshipIssue(
      candidate,
      'error',
      'ancestor-cycle',
      '该父母关系会形成祖先循环。',
    )
  }

  return undefined
}

export function hasAncestorCycle(relationships: Relationship[]): boolean {
  const childrenByParent = new Map<string, string[]>()
  for (const relationship of relationships) {
    if (relationship.category !== 'parent' || !LINEAGE_RELATIONS.has(relationship.type)) continue
    const children = childrenByParent.get(relationship.fromPersonId) ?? []
    children.push(relationship.toPersonId)
    childrenByParent.set(relationship.fromPersonId, children)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()

  for (const rootId of childrenByParent.keys()) {
    if (visited.has(rootId)) continue
    const stack: Array<{ personId: string; childIndex: number }> = [{ personId: rootId, childIndex: 0 }]
    visiting.add(rootId)

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const children = childrenByParent.get(frame.personId) ?? []
      if (frame.childIndex >= children.length) {
        stack.pop()
        visiting.delete(frame.personId)
        visited.add(frame.personId)
        continue
      }

      const childId = children[frame.childIndex++]!
      if (visiting.has(childId)) return true
      if (visited.has(childId)) continue
      visiting.add(childId)
      stack.push({ personId: childId, childIndex: 0 })
    }
  }

  return false
}
