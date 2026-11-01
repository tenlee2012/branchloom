<script setup lang="ts">
import { inject, ref } from 'vue'
import { IconLanguage } from '@tabler/icons-vue'
import BaseDialog from '../../design-system/BaseDialog.vue'
import BaseButton from '../../design-system/BaseButton.vue'
import BaseSelectControl from '../../design-system/BaseSelectControl.vue'
import { beforeLanguageRestartKey, changeLanguage, readLanguagePreference, t, type LanguagePreference } from '../../shared/i18n'

const preference = readLanguagePreference()
const pending = ref<LanguagePreference>(preference)
const confirming = ref(false)
const failure = ref('')
const applying = ref(false)
const beforeRestart = inject(beforeLanguageRestartKey, () => Promise.resolve())

function select(event: Event) {
  pending.value = (event.target as HTMLSelectElement).value as LanguagePreference
  confirming.value = pending.value !== preference
}

function cancel() {
  pending.value = preference
  confirming.value = false
  failure.value = ''
}

async function apply() {
  if (applying.value) return
  applying.value = true
  try {
    await changeLanguage(pending.value, undefined, beforeRestart)
  } catch {
    failure.value = t('无法保存语言设置，请检查本机存储权限后重试。')
  } finally {
    applying.value = false
  }
}
</script>

<template>
  <label class="language-select">
    <IconLanguage :size="18" aria-hidden="true" />
    <BaseSelectControl>
      <select :value="pending" :aria-label="t('界面语言')" @change="select">
        <option value="system">{{ t('跟随系统') }}</option>
        <option value="zh-CN">简体中文</option>
        <option value="en">English</option>
      </select>
    </BaseSelectControl>
  </label>
  <BaseDialog :open="confirming" :title="t('切换界面语言？')" :description="t('切换后会重新打开当前页面。请先保存尚未完成的编辑。')" @close="cancel">
    <p v-if="failure" role="alert">{{ failure }}</p>
    <div class="language-select__actions">
      <BaseButton variant="secondary" :disabled="applying" @click="cancel">{{ t('取消') }}</BaseButton>
      <BaseButton :loading="applying" @click="apply">{{ t('保存并切换') }}</BaseButton>
    </div>
  </BaseDialog>
</template>

<style scoped>
.language-select { display: inline-flex; min-width: 0; align-items: center; gap: .25rem; color: var(--color-muted); }
.language-select select { width: 9.5rem; min-width: 0; min-height: 2.75rem; font: inherit; font-size: .8125rem; }
.language-select__actions { display: flex; justify-content: flex-end; gap: var(--space-3); }
@media (max-width: 48rem) { .language-select { gap: 0; } .language-select > svg { display: none; } .language-select select { width: 8.25rem; padding-left: .5rem; padding-right: 1.75rem; } }
</style>
