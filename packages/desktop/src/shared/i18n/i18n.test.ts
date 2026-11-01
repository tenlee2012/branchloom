import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { changeLanguage, getLocale, initializeLocale, localizeSystemMessage, readLanguagePreference, resolveLocale, setLocale, t } from './index'
import { englishMessages } from './messages'
import { formatWindowTitle } from '../../app/windowTitle'
import { personNameTypeLabels } from '../domain/personNames'
import { eventTypeLabel } from '../domain/eventTypes'
import { chapterLabels } from '../domain/publication'

const native = vi.hoisted(() => ({ isTauri: vi.fn(() => false), invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => native)

beforeEach(() => {
  localStorage.clear()
  native.isTauri.mockReturnValue(false)
  native.invoke.mockReset()
})
afterEach(() => { vi.restoreAllMocks(); setLocale('zh-CN') })

describe('interface language', () => {
  it('resolves shared labels after native initialization even when modules were imported earlier', () => {
    setLocale('en')
    expect(personNameTypeLabels.personal).toBe('Personal name')
    expect(eventTypeLabel('birth')).toBe('Birth')
    expect(chapterLabels.cover).toBe('Cover')
    setLocale('zh-CN')
    expect(personNameTypeLabels.personal).toBe('名／讳')
    expect(eventTypeLabel('birth')).toBe('出生')
    expect(chapterLabels.cover).toBe('封面')
  })
  it.each(['zh', 'zh-CN', 'zh-Hant-TW', 'zh_CN.UTF-8', 'zh_TW@variant'])('supports Chinese locale %s', language => {
    expect(resolveLocale(language)).toBe('zh-CN')
  })
  it.each(['en-US', 'fr-FR', 'ja-JP', 'C', 'C.UTF-8', 'POSIX', '', undefined])('falls back to English for %s', language => {
    expect(resolveLocale(language)).toBe('en')
  })
  it('uses the primary browser/system language and updates document semantics', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('fr-FR')
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-FR', 'zh-CN'])
    await initializeLocale()
    expect(getLocale()).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(formatWindowTitle('家谱树')).toBe('Family tree · Branchloom')
  })
  it('honors native POSIX overrides before the webview language', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN')
    native.isTauri.mockReturnValue(true)
    native.invoke.mockResolvedValue('C.UTF-8')
    await initializeLocale()
    expect(native.invoke).toHaveBeenCalledWith('system_locale')
    expect(getLocale()).toBe('en')
    native.invoke.mockResolvedValue('zh_CN.UTF-8')
    await initializeLocale()
    expect(getLocale()).toBe('zh-CN')
  })
  it('preserves an explicit device preference and returns to system defaults', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US')
    const restart = vi.fn()
    await changeLanguage('zh-CN', restart)
    expect(restart).toHaveBeenCalledOnce()
    expect(readLanguagePreference()).toBe('zh-CN')
    await initializeLocale()
    expect(getLocale()).toBe('zh-CN')
    await changeLanguage('system', restart)
    await initializeLocale()
    expect(getLocale()).toBe('en')
  })
  it('falls back to the webview if the native locale cannot be read', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN')
    native.isTauri.mockReturnValue(true)
    native.invoke.mockRejectedValue(new Error('unavailable'))
    await initializeLocale()
    expect(getLocale()).toBe('zh-CN')
  })
  it('starts safely without preference storage', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US')
    await initializeLocale()
    expect(getLocale()).toBe('en')
  })
  it('saves the preference before removing drawer history, then restarts after history closes', async () => {
    const restart = vi.fn()
    let finishClose!: () => void
    const close = vi.fn(() => new Promise<void>(resolve => { finishClose = resolve }))
    const changed = changeLanguage('en', restart, close)
    expect(readLanguagePreference()).toBe('en')
    expect(close).toHaveBeenCalledOnce()
    expect(restart).not.toHaveBeenCalled()
    finishClose()
    await changed
    expect(restart).toHaveBeenCalledOnce()
  })
  it('keeps the current page and drawer available when preference storage rejects a write', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    const close = vi.fn(() => Promise.resolve())
    const restart = vi.fn()
    await expect(changeLanguage('en', restart, close)).rejects.toThrow('denied')
    expect(close).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
  })
  it('preserves user content and performs interpolation exactly once', () => {
    setLocale('en')
    expect(t('已选择：{0}', ['有谱 {1} $& <b>'])).toBe('Selected: 有谱 {1} $& <b>')
    expect(t('unrecognized text')).toBe('unrecognized text')
    expect(t('__proto__')).toBe('__proto__')
    setLocale('zh-CN')
    expect(t('已选择：{0}', ['Alice'])).toBe('已选择：Alice')
  })
  it('localizes native progress and errors without changing embedded names or unknown diagnostics', () => {
    setLocale('en')
    expect(localizeSystemMessage('正在读取 GitHub 资料 2 / 5…')).toBe('Reading GitHub records 2 / 5…')
    expect(localizeSystemMessage('validation failed: 所选范围没有人物，请调整范围或排除名单'))
      .toBe('validation failed: No people in the selected scope. Adjust the scope or exclusions')
    expect(localizeSystemMessage('附件“有谱”缺失。')).toBe('Attachment “有谱” is missing.')
    expect(localizeSystemMessage('无法保存本地资料：validation failed: 所选范围没有人物，请调整范围或排除名单'))
      .toBe('Unable to save local records: validation failed: No people in the selected scope. Adjust the scope or exclusions')
    expect(localizeSystemMessage('unknown error')).toBe('unknown error')
  })
})

describe('translation catalog completeness', () => {
  it('keeps every interpolation argument and provides English for each message', () => {
    for (const [source, translation] of Object.entries(englishMessages)) {
      const argumentsIn = (value: string) => [...new Set(value.match(/\{\d+\}/g) ?? [])].sort()
      expect(translation.trim(), source).not.toBe('')
      expect(translation, source).not.toMatch(/\p{Script=Han}/u)
      expect(argumentsIn(translation), source).toEqual(argumentsIn(source))
    }
  })
  it('covers application source messages, including lazy pages and dialogs', () => {
    function sources(directory: string): string[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const filename = join(directory, entry.name)
        if (entry.isDirectory()) return entry.name === 'i18n' ? [] : sources(filename)
        return /\.(vue|ts)$/.test(filename) && !filename.includes('.test.') ? [filename] : []
      })
    }
    for (const filename of sources(join(process.cwd(), 'src'))) {
      const source = readFileSync(filename, 'utf8')
      if (filename.endsWith('/app/router.ts')) {
        for (const match of source.matchAll(/'([^'\r\n]*\p{Script=Han}[^'\r\n]*)'/gu)) {
          expect(englishMessages[match[1]!], `Route metadata: ${match[1]}`).toBeDefined()
        }
      }
      for (const match of source.matchAll(/\bt\('((?:\\.|[^'\\])*)'/g)) {
        const message = match[1]!.replace(/\\'/g, "'").replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
        if (/\p{Script=Han}/u.test(message)) expect(englishMessages[message], `${filename}: ${message}`).toBeDefined()
      }
    }
  })
})
