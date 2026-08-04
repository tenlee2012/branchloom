<script setup lang="ts">
import { computed, ref } from 'vue'
import BaseDrawer from '../../../design-system/BaseDrawer.vue'
import type { Person } from '../../../shared/domain/types'
import PersonEditorForm from './PersonEditorForm.vue'

const props = defineProps<{ open: boolean; projectId: string; person?: Person }>()
const emit = defineEmits<{ close: []; saved: [person: Person] }>()
const form = ref<InstanceType<typeof PersonEditorForm>>()
const title = computed(() => props.person ? '编辑人物档案' : '新建人物')

function requestClose() {
  form.value?.requestClose()
}

function saved(person: Person) {
  emit('saved', person)
  emit('close')
}
</script>

<template>
  <BaseDrawer
    :open="open"
    :title="title"
    description="填写人物的常用资料与姓名信息。"
    close-label="关闭人物编辑器"
    @close="requestClose"
  >
    <PersonEditorForm
      v-if="open"
      ref="form"
      :project-id="projectId"
      v-bind="person ? { person } : {}"
      @cancel="emit('close')"
      @saved="saved"
    />
  </BaseDrawer>
</template>
