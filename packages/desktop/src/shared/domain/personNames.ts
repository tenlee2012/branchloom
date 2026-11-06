import { t } from '../i18n'
import type { Person, PersonName, PersonNameType } from './types'

export const personNameTypeLabels: Record<PersonNameType, string> = {
  get personal() { return t('名／讳') },
  get courtesy() { return t('字') },
  get art() { return t('号') },
  get genealogy() { return t('谱名') },
  get generation() { return t('行名') },
  get childhood() { return t('乳名／小名') },
  get former() { return t('曾用名') },
  get pen() { return t('笔名／艺名') },
  get religious() { return t('法名／道号') },
  get posthumous() { return t('谥号') },
  get temple() { return t('庙号') },
  get honorific() { return t('尊号') },
  get alias() { return t('别名') },
  get custom() { return t('自定义') },
}

export const editablePersonNameTypes: PersonNameType[] = [
  'personal',
  'courtesy',
  'art',
  'genealogy',
  'generation',
  'childhood',
  'former',
  'pen',
  'religious',
  'posthumous',
  'temple',
  'honorific',
  'alias',
  'custom',
]

export function getPrimaryNameRecord(person: Pick<Person, 'names'>): PersonName | undefined {
  return person.names.find(({ primary }) => primary) ?? person.names[0]
}

export function getPrimaryName(person: Pick<Person, 'names'>): string {
  return getPrimaryNameRecord(person)?.value ?? t('未命名人物')
}

/** Lower ranks prefer exact names, then prefixes, then substrings over matches in other fields. */
export function getNameSearchRank(person: Pick<Person, 'names'>, query: string): number {
  const search = query.trim().toLocaleLowerCase()
  if (!search) return 0
  const primaryName = getPrimaryNameRecord(person)
  return person.names.reduce((best, name) => {
    const value = name.value.trim().toLocaleLowerCase()
    const rank = value === search ? 0 : value.startsWith(search) ? 2 : value.includes(search) ? 4 : 6
    return Math.min(best, rank + (name === primaryName ? 0 : 1))
  }, 6)
}

export function isPrimaryName(_person: Pick<Person, 'names'>, name: PersonName): boolean {
  return name.primary
}
