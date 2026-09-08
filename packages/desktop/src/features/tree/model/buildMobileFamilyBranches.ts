import type { BoundedFamilySlice, Person, Relationship } from '../../../shared/domain/types'

export type MobileFamilyBranchKey = 'parents' | 'partners' | 'siblings' | 'children'

export interface MobileFamilyBranchItem {
  person: Person
  relationship: Relationship
  relationLabel: string
}

export interface MobileFamilyBranch {
  key: MobileFamilyBranchKey
  label: string
  hint: string
  items: MobileFamilyBranchItem[]
}

const parentLabels = {
  biological: '亲生',
  adoptive: '收养',
  step: '继亲',
  guardian: '监护',
} as const

const partnerLabels = {
  engaged: '订婚',
  married: '婚姻',
  partner: '伴侣',
  separated: '分居',
  divorced: '离异',
} as const

function uniqueItems(items: MobileFamilyBranchItem[]): MobileFamilyBranchItem[] {
  return [...new Map(items.map((item) => [item.person.id, item])).values()]
}

function resolvePerson(people: ReadonlyMap<string, Person>, personId: string): Person | undefined {
  const person = people.get(personId)
  return person?.deletedAt ? undefined : person
}

export function buildMobileFamilyBranches(
  slice: Pick<BoundedFamilySlice, 'people' | 'relationships'>,
  centerPersonId: string,
): MobileFamilyBranch[] {
  const people = new Map(slice.people.map((person) => [person.id, person]))
  const parents: MobileFamilyBranchItem[] = []
  const partners: MobileFamilyBranchItem[] = []
  const children: MobileFamilyBranchItem[] = []

  for (const relationship of slice.relationships) {
    if (relationship.category === 'parent' && relationship.toPersonId === centerPersonId) {
      const person = resolvePerson(people, relationship.fromPersonId)
      if (person) parents.push({
        person,
        relationship,
        relationLabel: `${parentLabels[relationship.type]}父母或监护人`,
      })
    }
    if (relationship.category === 'parent' && relationship.fromPersonId === centerPersonId) {
      const person = resolvePerson(people, relationship.toPersonId)
      if (person) children.push({
        person,
        relationship,
        relationLabel: `${parentLabels[relationship.type]}子女或被监护人`,
      })
    }
    if (relationship.category === 'partner'
      && (relationship.fromPersonId === centerPersonId || relationship.toPersonId === centerPersonId)) {
      const personId = relationship.fromPersonId === centerPersonId
        ? relationship.toPersonId
        : relationship.fromPersonId
      const person = resolvePerson(people, personId)
      if (person) partners.push({
        person,
        relationship,
        relationLabel: partnerLabels[relationship.type],
      })
    }
  }

  const parentIds = new Set(parents.map(({ person }) => person.id))
  const siblings = slice.relationships.flatMap((relationship): MobileFamilyBranchItem[] => {
    if (relationship.category !== 'parent'
      || !parentIds.has(relationship.fromPersonId)
      || relationship.toPersonId === centerPersonId) return []
    const person = resolvePerson(people, relationship.toPersonId)
    return person
      ? [{ person, relationship, relationLabel: '共同父母或监护人' }]
      : []
  })

  return [
    {
      key: 'parents',
      label: '父母与监护',
      hint: '向上一代',
      items: uniqueItems(parents),
    },
    {
      key: 'partners',
      label: '伴侣',
      hint: '共同生活',
      items: uniqueItems(partners),
    },
    {
      key: 'siblings',
      label: '兄弟姐妹',
      hint: '同代旁支',
      items: uniqueItems(siblings),
    },
    {
      key: 'children',
      label: '子女与被监护人',
      hint: '向下一代',
      items: uniqueItems(children),
    },
  ]
}
