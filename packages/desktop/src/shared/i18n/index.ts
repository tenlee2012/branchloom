import { englishMessages } from './messages'
import type { InjectionKey } from 'vue'

export const beforeLanguageRestartKey: InjectionKey<() => Promise<void>> = Symbol('beforeLanguageRestart')

export type AppLocale = 'zh-CN' | 'en'
export type LanguagePreference = 'system' | AppLocale
const preferenceKey = 'branchloom.ui-language'

/** Use the primary system language; secondary fallback languages do not override it. */
export function resolveLocale(language: string | null | undefined): AppLocale {
  return /^zh(?:[-_.@]|$)/i.test(language?.trim() ?? '') ? 'zh-CN' : 'en'
}

export function readLanguagePreference(): LanguagePreference {
  try {
    const saved = localStorage.getItem(preferenceKey)
    if (saved === 'zh-CN' || saved === 'en') return saved
  } catch {
    // Language is an optional device preference, independent of project data.
  }
  return 'system'
}

let currentLocale: AppLocale = resolveLocale(typeof navigator === 'undefined' ? undefined : navigator.language)

export function getLocale(): AppLocale { return currentLocale }

export function setLocale(locale: AppLocale): void {
  currentLocale = locale
  if (typeof document !== 'undefined') document.documentElement.lang = locale
}

export async function initializeLocale(): Promise<void> {
  const preference = readLanguagePreference()
  let systemLanguage = typeof navigator === 'undefined' ? undefined : navigator.language
  try {
    const { invoke, isTauri } = await import('@tauri-apps/api/core')
    if (isTauri()) systemLanguage = await invoke<string | null>('system_locale') ?? systemLanguage
  } catch {
    // Webview language remains usable if the native locale is unavailable.
  }
  setLocale(preference === 'system' ? resolveLocale(systemLanguage) : preference)
}

/** Restart after an explicit confirmation, so module-level labels use the same locale. */
export async function changeLanguage(
  preference: LanguagePreference,
  restart = () => window.location.reload(),
  beforeRestart = () => Promise.resolve(),
): Promise<void> {
  if (preference === 'system') localStorage.removeItem(preferenceKey)
  else localStorage.setItem(preferenceKey, preference)
  await beforeRestart()
  restart()
}

/** Translate application-owned text only. Names, dates and other user content stay untouched. */
export function t(message: string, parameters: readonly unknown[] = []): string {
  const translated = currentLocale === 'en' && Object.hasOwn(englishMessages, message) ? englishMessages[message]! : message
  return translated.replace(/\{(\d+)\}/g, (token, index: string) => (
    Number(index) < parameters.length ? String(parameters[Number(index)] ?? '') : token
  ))
}

let systemPatterns: Array<{ pattern: RegExp; source: string }> | undefined

/** Translate known native status/diagnostic templates at the UI boundary only. */
export function localizeSystemMessage(message: string): string {
  if (currentLocale !== 'en' || !/\p{Script=Han}/u.test(message)) return message
  if (Object.hasOwn(englishMessages, message)) return t(message)
  for (const prefix of ['validation failed: ', 'project data conflict: ', 'remote operation failed: ']) {
    if (message.startsWith(prefix)) return prefix + localizeSystemMessage(message.slice(prefix.length))
  }
  systemPatterns ??= Object.keys(englishMessages)
    .filter(source => /\{\d+\}/.test(source) && source.replace(/\{\d+\}/g, '').length >= 6)
    .sort((left, right) => right.replace(/\{\d+\}/g, '').length - left.replace(/\{\d+\}/g, '').length)
    .map(source => ({
      source,
      pattern: new RegExp('^' + source.split(/(\{\d+\})/).map(part => /^\{\d+\}$/.test(part)
        ? '([\\s\\S]*?)'
        : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$'),
    }))
  for (const { pattern, source } of systemPatterns) {
    const match = pattern.exec(message)
    if (!match) continue
    const parameters: string[] = []
    const positions = [...source.matchAll(/\{(\d+)\}/g)]
    positions.forEach((position, index) => { parameters[Number(position[1])] = match[index + 1]! })
    if ((source.startsWith('无法') || /(?:失败|异常)：\{0\}$/.test(source))
      && source.endsWith('：{0}') && /^(?:validation failed|project data conflict|remote operation failed): /.test(parameters[0] ?? '')) {
      parameters[0] = localizeSystemMessage(parameters[0]!)
    }
    return t(source, parameters)
  }
  return message
}
