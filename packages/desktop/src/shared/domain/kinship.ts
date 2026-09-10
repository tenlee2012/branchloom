import relationship from 'relationship.js'
import { isDefinitelyReversedDateRange } from './date'
import { getPrimaryName } from './personNames'
import type { Person, Relationship } from './types'

export interface KinshipDescription {
  label: string
  paths: string[]
}

interface Step {
  person: Person
  direction: 'parent' | 'child' | 'partner'
  relationship: Relationship
}

function gendered(person: Person, male: string, female: string, neutral: string): string {
  return person.sex === 'male' ? male : person.sex === 'female' ? female : neutral
}

function directTerm({ person, direction, relationship }: Step): string {
  if (relationship.category === 'partner') {
    const terms = {
      married: gendered(person, '老公', '老婆', '配偶'),
      divorced: gendered(person, '前夫', '前妻', '前配偶'),
      separated: gendered(person, '老公（分居）', '老婆（分居）', '配偶（分居）'),
      engaged: gendered(person, '未婚夫', '未婚妻', '订婚伴侣'),
      partner: '伴侣',
    }
    return terms[relationship.type] + (relationship.end && relationship.type !== 'divorced' ? '（关系已结束）' : '')
  }
  if (relationship.type === 'guardian') return direction === 'parent' ? '监护人' : '被监护人'
  const prefix = { biological: '', adoptive: '养', step: '继' }[relationship.type]
  if (direction === 'parent') {
    return prefix
      ? gendered(person, `${prefix}父`, `${prefix}母`, `${prefix}父母`)
      : gendered(person, '爸爸', '妈妈', '父母')
  }
  return prefix
    ? gendered(person, `${prefix}子`, `${prefix}女`, `${prefix}子女`)
    : gendered(person, '儿子', '女儿', '子女')
}

// Only non-overlapping exact dates or recorded ranges establish seniority.
// Approximate or overlapping dates leave the order unspecified.
function seniority(source: Person, target: Person): 'older' | 'younger' | undefined {
  const left = source.birth
  const right = target.birth
  if (!left || !right || !['exact', 'range'].includes(left.precision)
    || !['exact', 'range'].includes(right.precision)) return undefined
  if (left.start && right.end && isDefinitelyReversedDateRange(left.start, right.end)) return 'older'
  if (right.start && left.end && isDefinitelyReversedDateRange(right.start, left.end)) return 'younger'
  return undefined
}

function siblingTerm(source: Person, target: Person, prefix = ''): string {
  const age = seniority(source, target)
  if (prefix) {
    return gendered(target,
      `${prefix}${age === 'older' ? '哥' : age === 'younger' ? '弟' : '兄弟'}`,
      `${prefix}${age === 'older' ? '姐' : age === 'younger' ? '妹' : '姐妹'}`,
      `${prefix}亲`)
  }
  return gendered(target,
    age === 'older' ? '哥哥' : age === 'younger' ? '弟弟' : '兄弟',
    age === 'older' ? '姐姐' : age === 'younger' ? '妹妹' : '姐妹',
    '兄弟姐妹')
}

function pathTerm(source: Person, path: Step[]): string {
  const target = path.at(-1)!.person
  const fallback = () => path.map(directTerm).join('的')
  const pattern = path.map(({ direction }) => ({ parent: 'U', child: 'D', partner: 'S' })[direction]).join('')
  if (path.length === 1) return fallback()
  if (path.every(({ relationship }) => relationship.type === 'biological')) {
    const first = path[0]!.person
    if (/^U{4,}$/.test(pattern)) return `老祖宗（上 ${path.length} 代）`
    if (/^D{4,}$/.test(pattern)) return `后辈（下 ${path.length} 代）`
    switch (pattern) {
      case 'UU':
        if (first.sex === 'male') return gendered(target, '爷爷', '奶奶', '祖父母')
        if (first.sex === 'female') return gendered(target, '外公', '外婆', '外祖父母')
        break
      case 'DD':
        if (first.sex === 'male') return gendered(target, '孙子', '孙女', '孙辈')
        if (first.sex === 'female') return gendered(target, '外孙', '外孙女', '外孙辈')
        break
      case 'UD': return siblingTerm(source, target)
      case 'UUD':
        if (first.sex === 'female') return gendered(target, '舅舅', '姨妈', '妈妈的兄弟姐妹')
        if (first.sex === 'male') {
          const age = seniority(first, target)
          return gendered(target, age === 'older' ? '伯伯' : age === 'younger' ? '叔叔' : '伯伯 / 叔叔', '姑姑', '爸爸的兄弟姐妹')
        }
        break
      case 'UDD':
        if (path[1]!.person.sex === 'male') return gendered(target, '侄子', '侄女', '侄辈')
        if (path[1]!.person.sex === 'female') return gendered(target, '外甥', '外甥女', '外甥辈')
        break
      case 'UUDD': {
        const relative = path[2]!.person
        if (first.sex === 'male' && relative.sex === 'male') return siblingTerm(source, target, '堂')
        if (first.sex === 'female' || relative.sex === 'female') return siblingTerm(source, target, '表')
        break
      }
      case 'UUU':
        if (path.slice(0, 2).every(({ person }) => person.sex === 'male')) return gendered(target, '太爷爷', '太奶奶', '曾祖父母')
        break
      case 'DDD':
        if (path.slice(0, 2).every(({ person }) => person.sex === 'male')) return gendered(target, '曾孙', '曾孙女', '曾孙辈')
        break
    }
  }
  // Do not turn a parent's spouse into an inferred parent, or a spouse's child
  // into an inferred child. Non-biological and former relationships stay explicit.
  if (path.every(({ relationship }) => relationship.type === 'biological'
    || (relationship.type === 'married' && !relationship.end))) {
    if (pattern === 'SU') {
      if (path[0]!.person.sex === 'male') return gendered(target, '公公', '婆婆', '配偶的父母')
      if (path[0]!.person.sex === 'female') return gendered(target, '岳父', '岳母', '配偶的父母')
    }
    if (pattern === 'DS') {
      if (path[0]!.person.sex === 'male' && target.sex === 'female') return '儿媳'
      if (path[0]!.person.sex === 'female' && target.sex === 'male') return '女婿'
    }
  }
  return calculatorTerm(source, path) ?? fallback()
}

function calculatorTerm(source: Person, path: Step[]): string | undefined {
  const binary = (person: Person) => person.sex === 'male' || person.sex === 'female'
  if (!path.every(({ person, relationship: relation }, index) => {
    if (!binary(person)) return false
    if (relation.type === 'biological') return true
    const previous = index ? path[index - 1]!.person : source
    return relation.type === 'married' && !relation.end && binary(previous) && previous.sex !== person.sex
  })) return undefined
  // The calculator assumes conventional family identities. Avoid its spouse /
  // parent shortcuts where the graph has not actually recorded those identities.
  if (path.some((step, index) => index > 0 && (
    (path[index - 1]!.direction === 'partner' && step.direction !== 'parent')
    || (path[index - 1]!.direction === 'parent' && step.direction === 'partner')
  ))) return undefined
  if (path.length > 6) return '远房亲戚'
  const terms: string[] = []
  for (let index = 0; index < path.length; index += 1) {
    const step = path[index]!
    const next = path[index + 1]
    if (step.direction === 'parent' && next?.direction === 'child') {
      // These are distinct people sharing a recorded parent, never "myself".
      terms.push(siblingTerm(index ? path[index - 1]!.person : source, next.person))
      index += 1
    } else terms.push(directTerm(step))
  }
  const labels = relationship({ text: terms.join('的'), sex: source.sex === 'male' ? 1 : source.sex === 'female' ? 0 : -1, optimal: false })
    .filter((label) => label !== '自己')
  return labels.length ? [...new Set(labels)].join(' / ') : undefined
}

/** Derive display-only terms from recorded shortest paths in the loaded family.
 * Equal-length paths are retained, with a per-person cap to bound dense graphs.
 * Missing records, project boundaries and cycles never imply new relationships.
 */
export function buildKinshipDescriptions(
  people: readonly Person[],
  relationships: readonly Relationship[],
  sourcePersonId: string,
): Map<string, KinshipDescription> {
  const result = new Map<string, KinshipDescription>()
  const source = people.find(({ id, deletedAt }) => id === sourcePersonId && !deletedAt)
  if (!source) return result
  const personById = new Map(people
    .filter(({ projectId, deletedAt }) => projectId === source.projectId && !deletedAt)
    .map((person) => [person.id, person]))
  const adjacent = new Map<string, Step[]>()
  const add = (from: string, step: Step) => {
    const steps = adjacent.get(from) ?? []
    steps.push(step)
    adjacent.set(from, steps)
  }
  for (const relationship of [...relationships].sort((a, b) => a.id.localeCompare(b.id))) {
    if (relationship.projectId !== source.projectId) continue
    const from = personById.get(relationship.fromPersonId)
    const to = personById.get(relationship.toPersonId)
    if (!from || !to || from.id === to.id) continue
    add(from.id, { person: to, direction: relationship.category === 'parent' ? 'child' : 'partner', relationship })
    add(to.id, { person: from, direction: relationship.category === 'parent' ? 'parent' : 'partner', relationship })
  }

  const pathsById = new Map<string, Step[][]>([[source.id, [[]]]])
  const morePaths = new Set<string>()
  const queue: Array<{ personId: string; path: Step[] }> = [{ personId: source.id, path: [] }]
  for (let index = 0; index < queue.length; index += 1) {
    const { personId, path } = queue[index]!
    for (const step of adjacent.get(personId) ?? []) {
      const paths = pathsById.get(step.person.id) ?? []
      if (paths.length && paths[0]!.length !== path.length + 1) continue
      if (morePaths.has(personId)) morePaths.add(step.person.id)
      if (paths.length >= 8) {
        morePaths.add(step.person.id)
        continue
      }
      const next = [...path, step]
      paths.push(next)
      pathsById.set(step.person.id, paths)
      queue.push({ personId: step.person.id, path: next })
    }
  }

  result.set(source.id, { label: '本人', paths: [getPrimaryName(source)] })
  for (const [personId, paths] of pathsById) {
    if (personId === source.id) continue
    const labels = [...new Set(paths.map((path) => pathTerm(source, path)))].sort((a, b) => a.localeCompare(b, 'zh-CN'))
    result.set(personId, {
      label: labels.join(' / ') + (morePaths.has(personId) ? ' 等' : ''),
      paths: [...new Set(paths.map((path) => [getPrimaryName(source), ...path.map((step) => `${directTerm(step)}：${getPrimaryName(step.person)}`)].join(' → ')))],
    })
  }
  return result
}
