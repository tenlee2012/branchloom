import { t } from '../i18n'
export const builtInEventTypes = [
  { value: 'birth', get label() { return t('出生') } },
  { value: 'death', get label() { return t('死亡') } },
  { value: 'engagement', get label() { return t('订婚') } },
  { value: 'marriage', get label() { return t('婚姻') } },
  { value: 'separation', get label() { return t('分居') } },
  { value: 'divorce', get label() { return t('离异') } },
  { value: 'adoption', get label() { return t('收养') } },
  { value: 'migration', get label() { return t('迁徙') } },
  { value: 'residence', get label() { return t('居住') } },
  { value: 'education', get label() { return t('教育') } },
  { value: 'occupation', get label() { return t('职业') } },
  { value: 'accession', get label() { return t('即位') } },
  { value: 'military_campaign', get label() { return t('军事行动') } },
  { value: 'name_change', get label() { return t('改名') } },
] as const

const builtInLabels = new Map<string, (typeof builtInEventTypes)[number]>(
  builtInEventTypes.map(option => [option.value, option]),
)

export function eventTypeLabel(type: string): string {
  return builtInLabels.get(type)?.label ?? type
}
