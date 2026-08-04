import { describe, expect, it } from 'vitest'
import {
  compareGenealogyDates,
  normalizeIsoDate,
  parseGenealogyDate,
  validateLifeDates,
} from './date'
import * as relationshipDomain from './relationships'
import type {
  Attachment,
  AttachmentLink,
  BranchloomRepository,
  Citation,
  GenealogyDate,
  ParentRelationship,
  Person,
  Place,
  Relationship,
  Source,
  PartnerRelationship,
  UUID,
} from './types'

const projectId = 'project-test'

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: 'person-test',
    projectId,
    names: [{ value: '测试人物', type: 'personal', primary: true }],
    sex: 'unknown',
    status: 'unknown',
    biography: '',
    notes: '',
    sourceIds: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const { validateRelationship } = relationshipDomain

function parentRelationship(overrides: Partial<ParentRelationship> = {}): ParentRelationship {
  return {
    id: 'relationship-test',
    projectId,
    fromPersonId: 'person-a',
    toPersonId: 'person-b',
    category: 'parent',
    type: 'biological',
    notes: '',
    sourceIds: [],
    ...overrides,
  }
}

function partnerRelationship(overrides: Partial<PartnerRelationship> = {}): PartnerRelationship {
  return {
    id: 'relationship-partner-test',
    projectId,
    fromPersonId: 'person-a',
    toPersonId: 'person-b',
    category: 'partner',
    type: 'married',
    notes: '',
    sourceIds: [],
    ...overrides,
  }
}

function runtimeRelationshipGuard(value: unknown): boolean | undefined {
  const guard = (
    relationshipDomain as typeof relationshipDomain & {
      isRelationship?: (candidate: unknown) => candidate is Relationship
    }
  ).isRelationship
  return guard?.(value)
}

type RequiredRepositoryBoundary = BranchloomRepository extends {
  listPlaces(projectId: UUID): Promise<Place[]>
  savePlace(place: Place): Promise<Place>
  saveCitation(citation: Citation): Promise<Citation>
  saveAttachment(attachment: Attachment): Promise<Attachment>
  listAttachmentLinks(projectId: UUID): Promise<AttachmentLink[]>
  saveAttachmentLink(link: AttachmentLink): Promise<AttachmentLink>
  listSources(projectId: UUID): Promise<Source[]>
}
  ? true
  : false

const repositoryBoundaryIsComplete: RequiredRepositoryBoundary = true

describe('genealogy date utilities', () => {
  it('normalizes only reliable ISO calendar boundaries', () => {
    expect(normalizeIsoDate(' 1988-04-12 ')).toBe('1988-04-12')
    expect(normalizeIsoDate('1988-04')).toBe('1988-04')
    expect(normalizeIsoDate('1988')).toBe('1988')
    expect(normalizeIsoDate('927-03-21')).toBe('0927-03-21')
    expect(normalizeIsoDate('976-11-14')).toBe('0976-11-14')
    expect(normalizeIsoDate('1988-02-30')).toBeUndefined()
    expect(normalizeIsoDate('清光绪年间')).toBeUndefined()
    expect(parseGenealogyDate('清光绪年间')).toEqual({
      display: '清光绪年间',
      precision: 'unknown',
    })
  })

  it('sorts by usable boundaries and leaves unknown dates last and stable', () => {
    const early: GenealogyDate = {
      display: '约 1900 年',
      start: '1899-01-01',
      end: '1901-12-31',
      precision: 'about',
    }
    const late: GenealogyDate = {
      display: '1950 年以前',
      end: '1950-12-31',
      precision: 'before',
    }
    const unknown: GenealogyDate = { display: '年代不详', precision: 'unknown' }

    expect(compareGenealogyDates(early, late)).toBeLessThan(0)
    expect(compareGenealogyDates(late, unknown)).toBeLessThan(0)
    expect(compareGenealogyDates(unknown, early)).toBeGreaterThan(0)
    expect(compareGenealogyDates(unknown, { display: '不详', precision: 'unknown' })).toBe(0)
  })

  it('expands partial ISO dates before comparing their sortable boundaries', () => {
    const year: GenealogyDate = {
      display: '1950',
      start: '1950',
      end: '1950',
      precision: 'exact',
    }
    const sameYearRange: GenealogyDate = {
      display: '1950 年',
      start: '1950-01-01',
      end: '1950-12-31',
      precision: 'range',
    }
    const leapMonth: GenealogyDate = {
      display: '1952-02',
      start: '1952-02',
      end: '1952-02',
      precision: 'exact',
    }
    const sameLeapMonthRange: GenealogyDate = {
      display: '1952 年 2 月',
      start: '1952-02-01',
      end: '1952-02-29',
      precision: 'range',
    }

    expect(compareGenealogyDates(year, sameYearRange)).toBe(0)
    expect(compareGenealogyDates(leapMonth, sameLeapMonthRange)).toBe(0)
  })

  it('warns when an exact death precedes an exact birth', () => {
    const issues = validateLifeDates(
      person({
        id: 'person-impossible',
        birth: { display: '1950-01-01', start: '1950-01-01', end: '1950-01-01', precision: 'exact' },
        death: { display: '1949-12-31', start: '1949-12-31', end: '1949-12-31', precision: 'exact' },
      }),
    )

    expect(issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'death-before-birth',
        targetType: 'person',
        targetId: 'person-impossible',
      }),
    ])
  })

  it('does not warn for overlapping uncertain life-date ranges', () => {
    const issues = validateLifeDates(
      person({
        birth: { display: '约 1900—1910', start: '1900-01-01', end: '1910-12-31', precision: 'range' },
        death: { display: '约 1905—1920', start: '1905-01-01', end: '1920-12-31', precision: 'range' },
      }),
    )

    expect(issues).toEqual([])
  })

  it.each([
    {
      scenario: 'a birth within the same partial death year',
      death: { display: '1950', start: '1950', end: '1950', precision: 'exact' } as const,
      birth: {
        display: '1950-12-31',
        start: '1950-12-31',
        end: '1950-12-31',
        precision: 'exact',
      } as const,
    },
    {
      scenario: 'a birth within the same partial death month',
      death: { display: '1950-02', start: '1950-02', end: '1950-02', precision: 'exact' } as const,
      birth: {
        display: '1950-02-28',
        start: '1950-02-28',
        end: '1950-02-28',
        precision: 'exact',
      } as const,
    },
    {
      scenario: 'a leap-day birth within the same partial death month',
      death: { display: '1952-02', start: '1952-02', end: '1952-02', precision: 'exact' } as const,
      birth: {
        display: '1952-02-29',
        start: '1952-02-29',
        end: '1952-02-29',
        precision: 'exact',
      } as const,
    },
  ])('does not warn for $scenario', ({ birth, death }) => {
    expect(validateLifeDates(person({ birth, death }))).toEqual([])
  })

  it.each([
    {
      scenario: 'the year after a partial death year',
      death: { display: '1950', start: '1950', end: '1950', precision: 'exact' } as const,
      birth: {
        display: '1951-01-01',
        start: '1951-01-01',
        end: '1951-01-01',
        precision: 'exact',
      } as const,
    },
    {
      scenario: 'the month after a partial death month',
      death: { display: '1950-02', start: '1950-02', end: '1950-02', precision: 'exact' } as const,
      birth: {
        display: '1950-03-01',
        start: '1950-03-01',
        end: '1950-03-01',
        precision: 'exact',
      } as const,
    },
  ])('warns for a birth in $scenario', ({ birth, death }) => {
    expect(validateLifeDates(person({ birth, death }))).toEqual([
      expect.objectContaining({ code: 'death-before-birth' }),
    ])
  })

  it('does not invent a definite ordering from unbounded before or after dates', () => {
    const deathAfter = validateLifeDates(
      person({
        birth: {
          display: '1960-01-01',
          start: '1960-01-01',
          end: '1960-01-01',
          precision: 'exact',
        },
        death: { display: '1950 年以后', start: '1950', precision: 'after' },
      }),
    )
    const birthBefore = validateLifeDates(
      person({
        birth: { display: '1960 年以前', end: '1960', precision: 'before' },
        death: {
          display: '1950-01-01',
          start: '1950-01-01',
          end: '1950-01-01',
          precision: 'exact',
        },
      }),
    )

    expect(deathAfter).toEqual([])
    expect(birthBefore).toEqual([])
  })
})

describe('relationship domain boundaries', () => {
  it('keeps parent and partner type combinations discriminated at compile time', () => {
    const base = {
      id: 'relationship-invalid',
      projectId,
      fromPersonId: 'person-a',
      toPersonId: 'person-b',
      notes: '',
      sourceIds: [],
    }

    // @ts-expect-error parent relationships cannot use a partner relation type
    const invalidParent = { ...base, category: 'parent', type: 'married' } satisfies Relationship
    // @ts-expect-error partner relationships cannot use a parent relation type
    const invalidPartner = { ...base, category: 'partner', type: 'guardian' } satisfies Relationship

    expect([invalidParent, invalidPartner]).toHaveLength(2)
  })

  it('declares the complete place, citation and attachment repository boundary', () => {
    expect(repositoryBoundaryIsComplete).toBe(true)
  })

  it('accepts only structurally complete and correctly discriminated external relationships', () => {
    expect(runtimeRelationshipGuard(parentRelationship())).toBe(true)
    expect(runtimeRelationshipGuard(partnerRelationship())).toBe(true)
    expect(
      runtimeRelationshipGuard({ ...parentRelationship(), type: 'married' }),
    ).toBe(false)
    expect(
      runtimeRelationshipGuard({ ...partnerRelationship(), type: 'guardian' }),
    ).toBe(false)
    const { notes: _notes, ...missingNotes } = parentRelationship()
    expect(runtimeRelationshipGuard(missingNotes)).toBe(false)
    expect(runtimeRelationshipGuard({ ...parentRelationship(), sourceIds: [42] })).toBe(false)
    expect(
      runtimeRelationshipGuard({
        ...parentRelationship(),
        start: { display: '1950', precision: 'not-a-precision' },
      }),
    ).toBe(false)
  })
})

describe('validateRelationship', () => {
  it('rejects a person as their own parent', () => {
    const issue = validateRelationship(
      parentRelationship({ fromPersonId: 'person-a', toPersonId: 'person-a' }),
      [],
    )

    expect(issue).toEqual(expect.objectContaining({ severity: 'error', code: 'self-parent' }))
  })

  it('rejects a person as their own partner', () => {
    const issue = validateRelationship(
      partnerRelationship({ fromPersonId: 'person-a', toPersonId: 'person-a' }),
      [],
    )

    expect(issue).toEqual(expect.objectContaining({ severity: 'error', code: 'self-partner' }))
  })

  it('rejects a parent edge that closes an ancestor cycle', () => {
    const existing = [
      parentRelationship({ id: 'r1', fromPersonId: 'p1', toPersonId: 'p2' }),
      parentRelationship({ id: 'r2', fromPersonId: 'p2', toPersonId: 'p3' }),
    ]

    expect(
      validateRelationship(
        parentRelationship({ id: 'r3', fromPersonId: 'p3', toPersonId: 'p1' }),
        existing,
      ),
    ).toEqual(expect.objectContaining({ severity: 'error', code: 'ancestor-cycle' }))
  })

  it('excludes the replaced relationship from ancestor-cycle traversal', () => {
    const existing = parentRelationship({
      id: 'r1',
      fromPersonId: 'person-a',
      toPersonId: 'person-b',
    })
    const candidate = parentRelationship({
      id: 'r1',
      fromPersonId: 'person-b',
      toPersonId: 'person-a',
    })

    expect(validateRelationship(candidate, [existing])).toBeUndefined()
  })

  it('still rejects a true ancestor cycle when replacing a relationship', () => {
    const existing = [
      parentRelationship({ id: 'r1', fromPersonId: 'person-a', toPersonId: 'person-b' }),
      parentRelationship({ id: 'r2', fromPersonId: 'person-a', toPersonId: 'person-c' }),
      parentRelationship({ id: 'r3', fromPersonId: 'person-c', toPersonId: 'person-b' }),
    ]
    const candidate = parentRelationship({
      id: 'r1',
      fromPersonId: 'person-b',
      toPersonId: 'person-a',
    })

    expect(validateRelationship(candidate, existing)).toEqual(
      expect.objectContaining({ severity: 'error', code: 'ancestor-cycle' }),
    )
  })

  it('ignores partner edges during cycle detection and permits non-cycle parent edges', () => {
    const existing = [
      parentRelationship({ id: 'r1', fromPersonId: 'p1', toPersonId: 'p2' }),
      partnerRelationship({
        id: 'r2',
        fromPersonId: 'p2',
        toPersonId: 'p3',
      }),
    ]

    expect(
      validateRelationship(
        parentRelationship({ id: 'r3', fromPersonId: 'p3', toPersonId: 'p1' }),
        existing,
      ),
    ).toBeUndefined()
    expect(
      validateRelationship(
        parentRelationship({ id: 'r4', fromPersonId: 'p2', toPersonId: 'p4' }),
        existing,
      ),
    ).toBeUndefined()
  })

  it.each(['guardian', 'step'] as const)(
    'does not treat a reverse %s relationship as an ancestor cycle',
    (type) => {
      const biological = parentRelationship({
        id: 'lineage-parent',
        fromPersonId: 'p1',
        toPersonId: 'p2',
      })

      expect(
        validateRelationship(
          parentRelationship({
            id: `reverse-${type}`,
            fromPersonId: 'p2',
            toPersonId: 'p1',
            type,
          }),
          [biological],
        ),
      ).toBeUndefined()
    },
  )

  it('ignores existing guardian and step edges while traversing ancestors', () => {
    const nonLineageEdges = [
      parentRelationship({ id: 'guardian-edge', fromPersonId: 'p1', toPersonId: 'p2', type: 'guardian' }),
      parentRelationship({ id: 'step-edge', fromPersonId: 'p2', toPersonId: 'p3', type: 'step' }),
    ]

    expect(
      validateRelationship(
        parentRelationship({ id: 'biological-reverse', fromPersonId: 'p3', toPersonId: 'p1' }),
        nonLineageEdges,
      ),
    ).toBeUndefined()
  })

  it('still rejects self guardian relationships', () => {
    expect(
      validateRelationship(
        parentRelationship({ fromPersonId: 'person-a', toPersonId: 'person-a', type: 'guardian' }),
        [],
      ),
    ).toEqual(expect.objectContaining({ severity: 'error', code: 'self-parent' }))
  })

  it('warns for an identical directed parent relationship', () => {
    const existing = parentRelationship({ id: 'existing-parent' })
    const candidate = parentRelationship({ id: 'new-parent' })

    expect(validateRelationship(candidate, [existing])).toEqual(
      expect.objectContaining({ severity: 'warning', code: 'duplicate-relationship' }),
    )
  })

  it('ignores the edited relationship itself and relationships from other projects', () => {
    const candidate = parentRelationship({ id: 'relationship-edit' })
    const sameRecord = parentRelationship({ id: 'relationship-edit' })
    const otherProject = parentRelationship({
      id: 'relationship-other-project',
      projectId: 'project-other',
    })

    expect(validateRelationship(candidate, [sameRecord])).toBeUndefined()
    expect(validateRelationship(candidate, [otherProject])).toBeUndefined()
  })

  it('treats reversed partners as duplicates only when their type also matches', () => {
    const married = partnerRelationship({
      id: 'existing-partner',
      fromPersonId: 'person-a',
      toPersonId: 'person-b',
    })

    expect(
      validateRelationship(
        partnerRelationship({
          id: 'reversed-partner',
          fromPersonId: 'person-b',
          toPersonId: 'person-a',
        }),
        [married],
      ),
    ).toEqual(expect.objectContaining({ severity: 'warning', code: 'duplicate-relationship' }))

    expect(
      validateRelationship(
        partnerRelationship({
          id: 'different-partner',
          fromPersonId: 'person-b',
          toPersonId: 'person-a',
          type: 'divorced',
        }),
        [married],
      ),
    ).toBeUndefined()
  })
})
