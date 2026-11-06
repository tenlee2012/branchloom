import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import LanguageSelect from './components/LanguageSelect.vue'
import * as language from '../shared/i18n'

afterEach(() => vi.restoreAllMocks())

it('requires confirmation before changing language and cancel keeps unsaved edits on the page', async () => {
  localStorage.clear()
  const apply = vi.spyOn(language, 'changeLanguage').mockResolvedValue(undefined)
  const wrapper = mount(LanguageSelect, { attachTo: document.body })
  await wrapper.get('select').setValue('en')
  await flushPromises()
  const body = new DOMWrapper(document.body)
  expect(body.get('[role="dialog"]').text()).toContain('请先保存尚未完成的编辑')
  expect(apply).not.toHaveBeenCalled()
  await body.findAll('button').find(button => button.text() === '取消')!.trigger('click')
  expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('system')
  expect(apply).not.toHaveBeenCalled()
  await wrapper.get('select').setValue('en')
  await flushPromises()
  await body.findAll('button').find(button => button.text() === '保存并切换')!.trigger('click')
  await flushPromises()
  expect(apply).toHaveBeenCalledOnce()
  expect(apply.mock.calls[0]![0]).toBe('en')
  wrapper.unmount()
})

it('shows a recoverable error if the language preference cannot be saved', async () => {
  localStorage.clear()
  vi.spyOn(language, 'changeLanguage').mockRejectedValue(new Error('denied'))
  const wrapper = mount(LanguageSelect, { attachTo: document.body })
  await wrapper.get('select').setValue('en')
  await flushPromises()
  await new DOMWrapper(document.body).findAll('button').find(button => button.text() === '保存并切换')!.trigger('click')
  await flushPromises()
  const body = new DOMWrapper(document.body)
  expect(body.find('[role="dialog"]').exists()).toBe(true)
  expect(body.get('[role="alert"]').text()).toContain('无法保存语言设置')
  wrapper.unmount()
})
