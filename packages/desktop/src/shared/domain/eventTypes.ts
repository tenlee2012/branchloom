export const builtInEventTypes = [
  { value: 'birth', label: '出生' },
  { value: 'death', label: '死亡' },
  { value: 'engagement', label: '订婚' },
  { value: 'marriage', label: '婚姻' },
  { value: 'separation', label: '分居' },
  { value: 'divorce', label: '离异' },
  { value: 'adoption', label: '收养' },
  { value: 'migration', label: '迁徙' },
  { value: 'residence', label: '居住' },
  { value: 'education', label: '教育' },
  { value: 'occupation', label: '职业' },
  { value: 'accession', label: '即位' },
  { value: 'military_campaign', label: '军事行动' },
  { value: 'name_change', label: '改名' },
] as const

const builtInLabels = new Map<string, string>(
  builtInEventTypes.map(({ value, label }) => [value, label]),
)

export function eventTypeLabel(type: string): string {
  return builtInLabels.get(type) ?? type
}
