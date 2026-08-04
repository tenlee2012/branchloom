import type { Person } from './types'
import { getPrimaryName } from './personNames'

export interface DuplicateNameEvidence {
  personId: string
  normalizedName: string
  displayName: string
  bucketSize: number
}

export function findDuplicateNameEvidence(people: Person[]): DuplicateNameEvidence[] {
  const buckets = new Map<string, Array<{ personId: string; displayName: string }>>()

  for (const person of people) {
    const displayName = getPrimaryName(person).trim()
    const normalizedName = displayName.toLocaleLowerCase()
    if (!normalizedName) continue
    const bucket = buckets.get(normalizedName)
    const entry = { personId: person.id, displayName }
    if (bucket) bucket.push(entry)
    else buckets.set(normalizedName, [entry])
  }

  return [...buckets.entries()]
    .filter(([, entries]) => entries.length > 1)
    .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
    .flatMap(([normalizedName, entries]) => {
      const sorted = entries.sort((left, right) => left.personId.localeCompare(right.personId))
      const displayName = sorted[0]!.displayName
      return sorted.map(({ personId }) => ({
        personId,
        normalizedName,
        displayName,
        bucketSize: sorted.length,
      }))
    })
}
