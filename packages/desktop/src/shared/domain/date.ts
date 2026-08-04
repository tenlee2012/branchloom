import type { DataIssue, GenealogyDate, Person } from './types'

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function daysInMonth(year: number, month: number): number {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return days[month - 1] ?? 0
}

export function normalizeIsoDate(value: string): string | undefined {
  const normalized = value.trim()
  const match = /^(\d{1,4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(normalized)
  if (!match) return undefined

  const year = Number(match[1])
  if (year === 0) return undefined
  const paddedYear = String(year).padStart(4, '0')

  if (match[2] === undefined) return paddedYear
  const month = Number(match[2])
  if (month < 1 || month > 12) return undefined

  if (match[3] === undefined) return `${paddedYear}-${match[2]}`
  const day = Number(match[3])
  if (day < 1 || day > daysInMonth(year, month)) return undefined

  return `${paddedYear}-${match[2]}-${match[3]}`
}

export function parseGenealogyDate(value: string): GenealogyDate {
  const display = value.trim()
  const boundary = normalizeIsoDate(display)
  if (!boundary) return { display, precision: 'unknown' }

  return {
    display,
    start: boundary,
    end: boundary,
    precision: 'exact',
  }
}

interface IsoDateBounds {
  lower: string
  upper: string
}

function expandIsoDate(value: string): IsoDateBounds | undefined {
  const normalized = normalizeIsoDate(value)
  if (!normalized) return undefined

  const [year, month, day] = normalized.split('-')
  if (!month) return { lower: `${year}-01-01`, upper: `${year}-12-31` }
  if (!day) {
    const lastDay = String(daysInMonth(Number(year), Number(month))).padStart(2, '0')
    return {
      lower: `${year}-${month}-01`,
      upper: `${year}-${month}-${lastDay}`,
    }
  }

  return { lower: normalized, upper: normalized }
}

export function isDefinitelyReversedDateRange(start: string, end: string): boolean {
  const startBounds = expandIsoDate(start)
  const endBounds = expandIsoDate(end)
  return Boolean(startBounds && endBounds && startBounds.lower > endBounds.upper)
}

function sortableBoundaries(date: GenealogyDate): [string, string] | undefined {
  if (date.precision === 'unknown') return undefined

  const start = date.start ? expandIsoDate(date.start) : undefined
  const end = date.end ? expandIsoDate(date.end) : undefined
  const first = start?.lower ?? end?.upper
  if (!first) return undefined
  return [first, end?.upper ?? first]
}

function compareBoundaries(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

export function compareGenealogyDates(left: GenealogyDate, right: GenealogyDate): number {
  const leftBounds = sortableBoundaries(left)
  const rightBounds = sortableBoundaries(right)

  if (!leftBounds && !rightBounds) return 0
  if (!leftBounds) return 1
  if (!rightBounds) return -1

  const firstBoundary = compareBoundaries(leftBounds[0], rightBounds[0])
  return firstBoundary || compareBoundaries(leftBounds[1], rightBounds[1])
}

function earliestBoundary(date: GenealogyDate | undefined): string | undefined {
  if (!date || date.precision === 'unknown' || date.precision === 'before' || !date.start) {
    return undefined
  }
  return expandIsoDate(date.start)?.lower
}

function latestBoundary(date: GenealogyDate | undefined): string | undefined {
  if (!date || date.precision === 'unknown' || date.precision === 'after' || !date.end) {
    return undefined
  }
  return expandIsoDate(date.end)?.upper
}

export function validateLifeDates(person: Person): DataIssue[] {
  const earliestBirth = earliestBoundary(person.birth)
  const latestDeath = latestBoundary(person.death)

  if (!earliestBirth || !latestDeath || compareBoundaries(latestDeath, earliestBirth) >= 0) return []

  return [
    {
      id: `issue-${person.id}-death-before-birth`,
      severity: 'warning',
      code: 'death-before-birth',
      message: '死亡日期早于出生日期，请核对日期或不确定范围。',
      targetType: 'person',
      targetId: person.id,
    },
  ]
}
