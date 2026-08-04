import { compareGenealogyDates, normalizeIsoDate } from '../../../shared/domain/date'
import {
  builtInEventTypes,
  eventTypeLabel,
} from '../../../shared/domain/eventTypes'
import { getPrimaryName } from '../../../shared/domain/personNames'
import type { FamilyEvent, GenealogyDate, Person } from '../../../shared/domain/types'

export { builtInEventTypes, eventTypeLabel }

function validBoundary(value: string | undefined): string | undefined {
  return value ? normalizeIsoDate(value) : undefined
}

function boundarySpan(start: string | undefined, end: string | undefined): string | undefined {
  if (start && end && start !== end) return `${start}—${end}`
  return start ?? end
}

export function formatEventDate(date: GenealogyDate): string {
  if (date.display.trim()) return date.display
  if (date.precision === 'unknown') return '日期未知'

  const start = validBoundary(date.start)
  const end = validBoundary(date.end)
  if (date.precision === 'exact') return start ?? end ?? '日期未知'
  if (date.precision === 'about') {
    const value = boundarySpan(start, end)
    return value ? `约 ${value}` : '日期未知'
  }
  if (date.precision === 'before') {
    const value = end ?? start
    return value ? `${value} 以前` : '日期未知'
  }
  if (date.precision === 'after') {
    const value = start ?? end
    return value ? `${value} 以后` : '日期未知'
  }
  return boundarySpan(start, end) ?? '日期未知'
}

export interface TimelineGroup {
  key: string
  label: string
  year?: number
  unknown: boolean
  events: FamilyEvent[]
}

export interface GroupEventsOptions {
  participantId?: string
  eventType?: string
  placeId?: string
  page?: number
  pageSize?: number
}

export interface TimelineGroupsPage {
  groups: TimelineGroup[]
  totalEvents: number
  totalGroups: number
  page: number
  pageSize: number
  totalPages: number
}

function boundaryYear(date: GenealogyDate): number | undefined {
  if (date.precision === 'unknown') return undefined
  const boundary = date.precision === 'before'
    ? date.end ?? date.start
    : date.start ?? date.end
  if (!boundary) return undefined
  const normalized = normalizeIsoDate(boundary)
  return normalized ? Number(normalized.slice(0, 4)) : undefined
}

function compareEvents(left: FamilyEvent, right: FamilyEvent): number {
  const byDate = compareGenealogyDates(left.date, right.date)
  if (byDate) return byDate
  const byTitle = left.title.localeCompare(right.title, 'zh-CN')
  return byTitle || left.id.localeCompare(right.id)
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback
}

export function groupEvents(
  events: readonly FamilyEvent[],
  options: GroupEventsOptions = {},
): TimelineGroupsPage {
  const filtered = events.filter((event) => {
    if (options.participantId && !event.participantIds.includes(options.participantId)) return false
    if (options.eventType && event.type !== options.eventType) return false
    if (options.placeId && event.placeId !== options.placeId) return false
    return true
  })
  const grouped = new Map<string, TimelineGroup>()

  for (const event of [...filtered].sort(compareEvents)) {
    const year = boundaryYear(event.date)
    const key = year === undefined ? 'unknown' : String(year)
    let group = grouped.get(key)
    if (!group) {
      group = year === undefined
        ? { key, label: '日期未知', unknown: true, events: [] }
        : { key, label: `${year} 年`, year, unknown: false, events: [] }
      grouped.set(key, group)
    }
    group.events.push(event)
  }

  const allGroups = [...grouped.values()].sort((left, right) => {
    if (left.unknown !== right.unknown) return left.unknown ? 1 : -1
    return (left.year ?? 0) - (right.year ?? 0)
  })
  const pageSize = positiveInteger(options.pageSize, 20)
  const totalPages = Math.max(1, Math.ceil(allGroups.length / pageSize))
  const page = Math.min(positiveInteger(options.page, 1), totalPages)
  const start = (page - 1) * pageSize

  return {
    groups: allGroups.slice(start, start + pageSize),
    totalEvents: filtered.length,
    totalGroups: allGroups.length,
    page,
    pageSize,
    totalPages,
  }
}

interface DateBounds {
  lower?: string
  upper?: string
}

function endOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export interface IsoBoundaryBounds {
  lower: string
  upper: string
}

export function expandIsoBoundary(value: string | undefined): IsoBoundaryBounds | undefined {
  if (!value) return undefined
  const normalized = normalizeIsoDate(value)
  if (!normalized) return undefined
  const [year, month, day] = normalized.split('-')
  if (!month) return { lower: `${year}-01-01`, upper: `${year}-12-31` }
  if (!day) {
    const end = String(endOfMonth(Number(year), Number(month))).padStart(2, '0')
    return { lower: `${year}-${month}-01`, upper: `${year}-${month}-${end}` }
  }
  return { lower: normalized, upper: normalized }
}

function dateBounds(date: GenealogyDate | undefined): DateBounds {
  if (!date || date.precision === 'unknown') return {}
  const start = expandIsoBoundary(date.start)
  const end = expandIsoBoundary(date.end)
  const bounds: DateBounds = {}
  const lower = start?.lower ?? end?.lower
  const upper = end?.upper ?? start?.upper
  if (date.precision !== 'before' && lower) bounds.lower = lower
  if (date.precision !== 'after' && upper) bounds.upper = upper
  return bounds
}

function primaryName(person: Person): string {
  return getPrimaryName(person)
}

export function findLifespanWarnings(event: FamilyEvent, people: readonly Person[]): string[] {
  const participants = new Set(event.participantIds)
  const eventBounds = dateBounds(event.date)
  const warnings: string[] = []

  for (const person of people) {
    if (!participants.has(person.id)) continue
    const birth = dateBounds(person.birth)
    const death = dateBounds(person.death)
    const name = primaryName(person)
    if (eventBounds.upper && birth.lower && eventBounds.upper < birth.lower) {
      warnings.push(`${event.title || '该事件'}发生在${name}出生前，请核对日期。`)
    }
    if (eventBounds.lower && death.upper && eventBounds.lower > death.upper) {
      warnings.push(`${event.title || '该事件'}发生在${name}死亡后，请核对日期。`)
    }
  }

  return warnings
}
