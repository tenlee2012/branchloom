import { describe, expect, it } from 'vitest'
import { buildKinshipDescriptions } from './kinship'
import { parseGenealogyDate } from './date'
import type { Person, Relationship, Sex } from './types'

function person(id: string, sex: Sex = 'male', birth = '1980'): Person {
  return { id, projectId: 'test-project', sex, birth: parseGenealogyDate(birth),
    names: [{ value: id, type: 'personal', primary: true }], status: 'unknown',
    biography: '', notes: '', updatedAt: '2026-01-01T00:00:00Z' }
}

function parent(from: Person, to: Person, type: 'biological' | 'adoptive' | 'step' | 'guardian' = 'biological'): Relationship {
  return { id: `${from.id}-${to.id}-${type}`, projectId: 'test-project',
    fromPersonId: from.id, toPersonId: to.id, category: 'parent', type, notes: '', sourceIds: [] }
}

function chain(steps: ReadonlyArray<readonly [direction: 'up' | 'down' | 'spouse', sex: Sex, birth?: string]>) {
  const people = [person('self')]
  const relationships: Relationship[] = []
  for (const [direction, sex, birth] of steps) {
    const previous = people.at(-1)!
    const next = person(`relative-${people.length}`, sex, birth)
    people.push(next)
    relationships.push(direction === 'spouse'
      ? { id: `${previous.id}-${next.id}`, projectId: 'test-project', fromPersonId: previous.id,
          toPersonId: next.id, category: 'partner', type: 'married', notes: '', sourceIds: [] }
      : direction === 'up' ? parent(next, previous) : parent(previous, next))
  }
  return { people, relationships, source: people[0]!, target: people.at(-1)! }
}

function label(family: ReturnType<typeof chain>) {
  return buildKinshipDescriptions(family.people, family.relationships, family.source.id).get(family.target.id)?.label
}

describe('kinship descriptions from recorded family paths', () => {
  it.each<[string, Parameters<typeof chain>[0], string]>([
    ['father', [['up', 'male']], '爸爸'],
    ['mother', [['up', 'female']], '妈妈'],
    ['paternal grandfather', [['up', 'male'], ['up', 'male']], '爷爷'],
    ['paternal grandmother', [['up', 'male'], ['up', 'female']], '奶奶'],
    ['maternal grandfather', [['up', 'female'], ['up', 'male']], '外公'],
    ['maternal grandmother', [['up', 'female'], ['up', 'female']], '外婆'],
    ['great grandfather', [['up', 'male'], ['up', 'male'], ['up', 'male']], '太爷爷'],
    ['great grandmother', [['up', 'male'], ['up', 'male'], ['up', 'female']], '太奶奶'],
    ['older brother', [['up', 'male'], ['down', 'male', '1975']], '哥哥'],
    ['younger brother', [['up', 'female'], ['down', 'male', '1985']], '弟弟'],
    ['unknown age brother', [['up', 'male'], ['down', 'male', '1980']], '兄弟'],
    ['older sister', [['up', 'male'], ['down', 'female', '1975']], '姐姐'],
    ['younger sister', [['up', 'female'], ['down', 'female', '1985']], '妹妹'],
    ['unknown age sister', [['up', 'male'], ['down', 'female', '1980']], '姐妹'],
    ['paternal uncle', [['up', 'male', '1950'], ['up', 'female'], ['down', 'male', '1955']], '叔叔'],
    ['older paternal uncle', [['up', 'male', '1950'], ['up', 'female'], ['down', 'male', '1945']], '伯伯'],
    ['aunt', [['up', 'male'], ['up', 'female'], ['down', 'female']], '姑姑'],
    ['maternal uncle', [['up', 'female'], ['up', 'male'], ['down', 'male']], '舅舅'],
    ['paternal cousin', [['up', 'male'], ['up', 'male'], ['down', 'male'], ['down', 'female', '1985']], '堂妹'],
    ['maternal cousin', [['up', 'female'], ['up', 'female'], ['down', 'male'], ['down', 'male', '1975']], '表哥'],
    ['nephew', [['up', 'male'], ['down', 'male'], ['down', 'male']], '侄子'],
    ['sister’s daughter', [['up', 'male'], ['down', 'female'], ['down', 'female']], '外甥女'],
    ['son', [['down', 'male']], '儿子'],
    ['daughter', [['down', 'female']], '女儿'],
    ['granddaughter', [['down', 'male'], ['down', 'female']], '孙女'],
    ['daughter’s son', [['down', 'female'], ['down', 'male']], '外孙'],
    ['wife', [['spouse', 'female']], '老婆'],
    ['wife’s mother', [['spouse', 'female'], ['up', 'female']], '岳母'],
    ['daughter-in-law', [['down', 'male'], ['spouse', 'female']], '儿媳'],
    ['calculator: brother’s wife', [['up', 'male'], ['down', 'male', '1970'], ['spouse', 'female']], '嫂子'],
    ['calculator: wife’s younger brother', [['spouse', 'female', '1980'], ['up', 'male'], ['down', 'male', '1985']], '小舅子'],
  ])('uses everyday terms for %s', (_name, steps, expected) => {
    expect(label(chain(steps))).toBe(expected)
  })

  it('summarizes distant direct ancestors with generation counts and preserves their paths', () => {
    const family = chain(Array.from({ length: 8 }, () => ['up', 'male'] as const))
    const descriptions = buildKinshipDescriptions(family.people, family.relationships, family.source.id)
    expect(descriptions.get('relative-4')?.label).toBe('老祖宗（上 4 代）')
    expect(descriptions.get(family.target.id)).toMatchObject({ label: '老祖宗（上 8 代）' })
    expect(descriptions.get(family.target.id)?.paths[0]).toContain(`爸爸：${family.target.id}`)
    expect(buildKinshipDescriptions(family.people, family.relationships, family.target.id).get(family.source.id)?.label)
      .toBe('后辈（下 8 代）')
  })

  it('does not establish seniority from approximate, overlapping or unknown dates', () => {
    const family = chain([['up', 'male'], ['down', 'male', '1975']])
    family.target.birth!.precision = 'about'
    expect(label(family)).toBe('兄弟')
    family.target.birth = { precision: 'range', display: '1970—1990', start: '1970', end: '1990' }
    expect(label(family)).toBe('兄弟')
    family.target.birth = undefined
    expect(label(family)).toBe('兄弟')
  })

  it.each([
    ['adoptive', '养母', '养子'], ['step', '继母', '继子'], ['guardian', '监护人', '被监护人'],
  ] as const)('keeps %s relations explicit in both directions and longer paths', (type, up, down) => {
    const family = chain([['up', 'female']])
    family.relationships[0] = parent(family.target, family.source, type)
    expect(label(family)).toBe(up)
    expect(buildKinshipDescriptions(family.people, family.relationships, family.target.id).get(family.source.id)?.label).toBe(down)
    const grandma = person('grandma', 'female')
    family.people.push(grandma)
    family.relationships.push(parent(grandma, family.target))
    expect(buildKinshipDescriptions(family.people, family.relationships, family.source.id).get(grandma.id)?.label).toBe(`${up}的妈妈`)
  })

  it.each([
    ['engaged', '未婚妻'], ['partner', '伴侣'], ['separated', '老婆（分居）'], ['divorced', '前妻'],
  ] as const)('preserves %s partner status instead of inferring current marriage', (type, term) => {
    const family = chain([['spouse', 'female'], ['up', 'female']])
    family.relationships[0] = { ...family.relationships[0]!, category: 'partner', type }
    const descriptions = buildKinshipDescriptions(family.people, family.relationships, family.source.id)
    expect(descriptions.get('relative-1')?.label).toBe(term)
    expect(descriptions.get(family.target.id)?.label).toBe(`${term}的妈妈`)
  })

  it('does not invent identities from spouses, unknown sex, same-sex marriage or ended marriage', () => {
    expect(label(chain([['up', 'male'], ['spouse', 'female']]))).toBe('爸爸的老婆')
    expect(label(chain([['spouse', 'female'], ['down', 'male']]))).toBe('老婆的儿子')
    expect(label(chain([['up', 'unknown'], ['up', 'female']]))).toBe('父母的妈妈')
    expect(label(chain([['down', 'male'], ['spouse', 'male']]))).toBe('儿子的老公')
    expect(label(chain([['up', 'female'], ['down', 'nonbinary']]))).toBe('兄弟姐妹')
    const ended = chain([['spouse', 'female'], ['up', 'female']])
    ended.relationships[0]!.end = parseGenealogyDate('2020')
    expect(label(ended)).toBe('老婆（关系已结束）的妈妈')
  })

  it('retains equally short relationships deterministically and terminates on cycles and self-relations', () => {
    const family = chain([['up', 'male']])
    family.relationships.push(parent(family.target, family.source, 'adoptive'), parent(family.source, family.target), parent(family.source, family.source))
    const before = JSON.stringify(family)
    const result = buildKinshipDescriptions(family.people, family.relationships, family.source.id)
    expect(result.get(family.source.id)?.label).toBe('本人')
    expect(result.get(family.target.id)?.label).toContain('爸爸')
    expect(result.get(family.target.id)?.label).toContain('养父')
    expect(result.get(family.target.id)?.label).toContain('儿子')
    expect(buildKinshipDescriptions(family.people, [...family.relationships].reverse(), family.source.id)).toEqual(result)
    expect(JSON.stringify(family)).toBe(before)
  })

  it('ignores missing, deleted and cross-project people and relationships', () => {
    const source = person('self')
    const unrelated = person('unrelated')
    const deleted = { ...person('deleted'), deletedAt: '2026-01-02' }
    const foreign = { ...person('foreign'), projectId: 'other-project' }
    const wrongScope = person('wrong-scope')
    const relationships = [parent(deleted, source), parent(foreign, source), parent(person('missing'), source),
      { ...parent(wrongScope, source), projectId: 'other-project' }]
    const people = [source, unrelated, deleted, foreign, wrongScope]
    expect([...buildKinshipDescriptions(people, relationships, source.id).keys()]).toEqual([source.id])
    expect(buildKinshipDescriptions(people, relationships, 'missing').size).toBe(0)
    expect(buildKinshipDescriptions(people, relationships, deleted.id).size).toBe(0)
  })

  it('caps alternative paths in dense graphs and marks omitted alternatives', () => {
    const source = person('self')
    const target = person('sibling')
    const parents = Array.from({ length: 20 }, (_, index) => person(`parent-${index}`))
    const descriptions = buildKinshipDescriptions([source, target, ...parents], parents.flatMap((p) => [parent(p, source), parent(p, target)]), source.id)
    expect(descriptions.get(target.id)?.paths).toHaveLength(8)
    expect(descriptions.get(target.id)?.label).toBe('兄弟 等')
  })
})
