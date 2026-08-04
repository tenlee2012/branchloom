import type { Person, PersonName, PersonNameType } from './types'

export const personNameTypeLabels: Record<PersonNameType, string> = {
  personal: '名／讳',
  courtesy: '字',
  art: '号',
  genealogy: '谱名',
  generation: '行名',
  childhood: '乳名／小名',
  former: '曾用名',
  pen: '笔名／艺名',
  religious: '法名／道号',
  posthumous: '谥号',
  temple: '庙号',
  honorific: '尊号',
  alias: '别名',
  custom: '自定义',
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
  return getPrimaryNameRecord(person)?.value ?? '未命名人物'
}

export function isPrimaryName(_person: Pick<Person, 'names'>, name: PersonName): boolean {
  return name.primary
}
