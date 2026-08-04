import {
  computed,
  inject,
  onScopeDispose,
  ref,
  toValue,
  watch,
  type MaybeRefOrGetter,
} from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
import type {
  BranchloomRepository,
  Page,
  Person,
  PersonQuery,
  PersonStatus,
  Sex,
} from '../../../shared/domain/types'

const PAGE_SIZE = 5
const SEARCH_DELAY = 200

export interface PeopleSearchScheduler {
  schedule(callback: () => void, delay: number): () => void
}

export const peopleSearchSchedulerKey = Symbol.for('branchloom.peopleSearchScheduler')

const browserScheduler: PeopleSearchScheduler = {
  schedule(callback, delay) {
    const timer = window.setTimeout(callback, delay)
    return () => window.clearTimeout(timer)
  },
}

type SourceFilter = '' | 'with' | 'without'
type BooleanFilter = '' | 'with' | 'without'
type PeopleSort = PersonQuery['sort']

function queryValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseStatus(value: unknown): PersonStatus | '' {
  const candidate = queryValue(value)
  return candidate === 'living' || candidate === 'deceased' || candidate === 'unknown'
    ? candidate
    : ''
}

function parseSourceFilter(value: unknown): SourceFilter {
  const candidate = queryValue(value)
  if (candidate === 'true') return 'with'
  if (candidate === 'false') return 'without'
  return ''
}

function parseBooleanFilter(value: unknown): BooleanFilter {
  return parseSourceFilter(value)
}

function parseSex(value: unknown): Sex | '' {
  const candidate = queryValue(value)
  return candidate === 'female'
    || candidate === 'male'
    || candidate === 'nonbinary'
    || candidate === 'unknown'
    ? candidate
    : ''
}

function parseSort(value: unknown): PeopleSort {
  const candidate = queryValue(value)
  return candidate === 'updatedAt' || candidate === 'birth' ? candidate : 'name'
}

function parsePage(value: unknown): number {
  const candidate = Number.parseInt(queryValue(value), 10)
  return Number.isInteger(candidate) && candidate > 0 ? candidate : 1
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return '人物资料暂时无法读取，请重试'
  return error.message.trim() || '人物资料暂时无法读取，请重试'
}

export function usePeopleQuery(
  repository: BranchloomRepository,
  projectId: MaybeRefOrGetter<string>,
) {
  const route = useRoute()
  const router = useRouter()
  const scheduler = inject(peopleSearchSchedulerKey, browserScheduler)
  const searchInput = ref(queryValue(route.query.search))
  const result = ref<Page<Person>>({ items: [], total: 0, page: 1, pageSize: PAGE_SIZE })
  const loadState = ref<'loading' | 'ready' | 'error'>('loading')
  const loadError = ref('')
  const retryVersion = ref(0)
  let cancelScheduledSearch: (() => void) | undefined
  let latestRequest = 0
  let navigationQueue = Promise.resolve()
  let previousProjectId = toValue(projectId)

  const status = computed(() => parseStatus(route.query.status))
  const sex = computed(() => parseSex(route.query.sex))
  const sourceFilter = computed(() => parseSourceFilter(route.query.hasSources))
  const avatarFilter = computed(() => parseBooleanFilter(route.query.hasAvatar))
  const birthFilter = computed(() => parseBooleanFilter(route.query.hasBirth))
  const deathFilter = computed(() => parseBooleanFilter(route.query.hasDeath))
  const issueFilter = computed(() => parseBooleanFilter(route.query.hasIssues))
  const sort = computed(() => parseSort(route.query.sort))
  const page = computed(() => parsePage(route.query.page))
  const totalPages = computed(() => Math.max(1, Math.ceil(result.value.total / PAGE_SIZE)))
  const querySignature = computed(() => [
    toValue(projectId),
    queryValue(route.query.search).trim(),
    status.value,
    sex.value,
    sourceFilter.value,
    avatarFilter.value,
    birthFilter.value,
    deathFilter.value,
    issueFilter.value,
    sort.value,
    page.value,
    retryVersion.value,
  ].join('\u0000'))

  function repositoryQuery(): PersonQuery {
    const query: PersonQuery = {
      page: page.value,
      pageSize: PAGE_SIZE,
      sort: sort.value,
    }
    const search = queryValue(route.query.search).trim()
    if (search) query.search = search
    if (status.value) query.status = status.value
    if (sex.value) query.sex = sex.value
    if (sourceFilter.value) query.hasSources = sourceFilter.value === 'with'
    if (avatarFilter.value) query.hasAvatar = avatarFilter.value === 'with'
    if (birthFilter.value) query.hasBirth = birthFilter.value === 'with'
    if (deathFilter.value) query.hasDeath = deathFilter.value === 'with'
    if (issueFilter.value) query.hasIssues = issueFilter.value === 'with'
    return query
  }

  function updateUrl(
    patch: Record<string, string | undefined>,
    mode: 'push' | 'replace' = 'push',
  ): Promise<void> {
    latestRequest += 1
    navigationQueue = navigationQueue.catch(() => undefined).then(async () => {
      const current = router.currentRoute.value
      const query: LocationQueryRaw = { ...current.query }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === '') delete query[key]
        else query[key] = value
      }
      await router[mode]({ name: 'project-people', params: current.params, query })
    })
    return navigationQueue
  }

  function updateSearch(value: string) {
    searchInput.value = value
    cancelScheduledSearch?.()
    cancelScheduledSearch = scheduler.schedule(() => {
      cancelScheduledSearch = undefined
      void updateUrl({ search: value.trim() || undefined, page: undefined })
    }, SEARCH_DELAY)
  }

  function updateStatus(value: string) {
    void updateUrl({ status: parseStatus(value) || undefined, page: undefined })
  }

  function updateSex(value: string) {
    void updateUrl({ sex: parseSex(value) || undefined, page: undefined })
  }

  function updateSourceFilter(value: string) {
    const parsed = value === 'with' || value === 'without' ? value : ''
    void updateUrl({
      hasSources: parsed ? String(parsed === 'with') : undefined,
      page: undefined,
    })
  }

  function updateBooleanFilter(
    key: 'hasAvatar' | 'hasBirth' | 'hasDeath' | 'hasIssues',
    value: string,
  ) {
    const parsed = value === 'with' || value === 'without' ? value : ''
    void updateUrl({
      [key]: parsed ? String(parsed === 'with') : undefined,
      page: undefined,
    })
  }

  function updateSort(value: string) {
    const parsed = value === 'updatedAt' || value === 'birth' ? value : 'name'
    void updateUrl({ sort: parsed === 'name' ? undefined : parsed, page: undefined })
  }

  function goToPage(nextPage: number) {
    const safePage = Math.min(Math.max(1, nextPage), totalPages.value)
    void updateUrl({ page: safePage === 1 ? undefined : String(safePage) })
  }

  function clearFilters() {
    cancelScheduledSearch?.()
    cancelScheduledSearch = undefined
    searchInput.value = ''
    void updateUrl({
      search: undefined,
      status: undefined,
      sex: undefined,
      hasSources: undefined,
      hasAvatar: undefined,
      hasBirth: undefined,
      hasDeath: undefined,
      hasIssues: undefined,
      sort: undefined,
      page: undefined,
    })
  }

  function retry() {
    retryVersion.value += 1
  }

  watch(
    () => queryValue(route.query.search),
    (search) => {
      if (searchInput.value === search) return
      cancelScheduledSearch?.()
      cancelScheduledSearch = undefined
      searchInput.value = search
    },
  )

  watch(
    () => toValue(projectId),
    (nextProjectId) => {
      if (!previousProjectId || nextProjectId === previousProjectId) {
        previousProjectId = nextProjectId
        return
      }
      previousProjectId = nextProjectId
      cancelScheduledSearch?.()
      cancelScheduledSearch = undefined
      searchInput.value = ''
      void updateUrl({
        search: undefined,
        status: undefined,
        sex: undefined,
        hasSources: undefined,
        hasAvatar: undefined,
        hasBirth: undefined,
        hasDeath: undefined,
        hasIssues: undefined,
        sort: undefined,
        page: undefined,
      }, 'replace')
    },
  )

  watch(
    querySignature,
    async () => {
      const request = ++latestRequest
      const activeProjectId = toValue(projectId)
      if (!activeProjectId) return
      loadState.value = 'loading'
      loadError.value = ''
      try {
        const pageResult = await repository.listPeople(activeProjectId, repositoryQuery())
        if (request !== latestRequest) return
        const lastPage = Math.max(1, Math.ceil(pageResult.total / PAGE_SIZE))
        if (page.value > lastPage) {
          await updateUrl(
            { page: lastPage === 1 ? undefined : String(lastPage) },
            'replace',
          )
          return
        }
        result.value = pageResult
        loadState.value = 'ready'
      } catch (error) {
        if (request !== latestRequest) return
        loadError.value = errorMessage(error)
        loadState.value = 'error'
      }
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    latestRequest += 1
    cancelScheduledSearch?.()
  })

  return {
    searchInput,
    status,
    sex,
    sourceFilter,
    avatarFilter,
    birthFilter,
    deathFilter,
    issueFilter,
    sort,
    page,
    result,
    totalPages,
    loadState,
    loadError,
    updateSearch,
    updateStatus,
    updateSex,
    updateSourceFilter,
    updateAvatarFilter: (value: string) => updateBooleanFilter('hasAvatar', value),
    updateBirthFilter: (value: string) => updateBooleanFilter('hasBirth', value),
    updateDeathFilter: (value: string) => updateBooleanFilter('hasDeath', value),
    updateIssueFilter: (value: string) => updateBooleanFilter('hasIssues', value),
    updateSort,
    goToPage,
    clearFilters,
    retry,
  }
}
