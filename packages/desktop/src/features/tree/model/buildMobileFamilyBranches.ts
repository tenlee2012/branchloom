import { t } from '../../../shared/i18n'
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
  get biological() { return t('亲生') },
  get adoptive() { return t('收养') },
  get step() { return t('继亲') },
  get guardian() { return t('监护') },
} as const

const partnerLabels = {
  get engaged() { return t('订婚') },
  get married() { return t('婚姻') },
  get partner() { return t('伴侣') },
  get separated() { return t('分居') },
  get divorced() { return t('离异') },
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
        relationLabel: t('{0}父母或监护人', [parentLabels[relationship.type]]),
      })
    }
    if (relationship.category === 'parent' && relationship.fromPersonId === centerPersonId) {
      const person = resolvePerson(people, relationship.toPersonId)
      if (person) children.push({
        person,
        relationship,
        relationLabel: t('{0}子女或被监护人', [parentLabels[relationship.type]]),
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
      ? [{ person, relationship, relationLabel: t('共同父母或监护人') }]
      : []
  })

  return [
    {
      key: 'parents',
      label: t('父母与监护'),
      hint: t('向上一代'),
      items: uniqueItems(parents),
    },
    {
      key: 'partners',
      label: t('伴侣'),
      hint: t('共同生活'),
      items: uniqueItems(partners),
    },
    {
      key: 'siblings',
      label: t('兄弟姐妹'),
      hint: t('同代旁支'),
      items: uniqueItems(siblings),
    },
    {
      key: 'children',
      label: t('子女与被监护人'),
      hint: t('向下一代'),
      items: uniqueItems(children),
    },
  ]
}
