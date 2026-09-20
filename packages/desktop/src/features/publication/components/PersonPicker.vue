<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import type { PublicationPerson } from '../../../shared/domain/publication'
const props = defineProps<{ people: PublicationPerson[]; modelValue: string[]; label: string; single?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [ids: string[]] }>()
const query = ref('')
const id = useId()
const name = (person: PublicationPerson) => person.names.find((name) => name.primary)?.value ?? person.names[0]?.value ?? '未命名人物'
const results = computed(() => props.people.filter((person) => !props.modelValue.includes(person.id)
  && (!query.value || person.names.some((name) => name.value.includes(query.value)) || person.id.includes(query.value))).slice(0, 30))
const selected = computed(() => props.modelValue.map((id) => ({ id, name: name(props.people.find((person) => person.id === id) ?? { id, names: [] }) })))
function add(id: string) { emit('update:modelValue', props.single ? [id] : [...props.modelValue, id]); query.value = '' }
</script>
<template>
  <div class="person-picker">
    <label :for="id">{{ label }}</label>
    <div v-if="selected.length" class="person-picker__selected">
      <button v-for="person in selected" :key="person.id" type="button" :aria-label="`移除${person.name}`" @click="emit('update:modelValue', modelValue.filter((id) => id !== person.id))">{{ person.name }} ×</button>
    </div>
    <input :id="id" v-model="query" type="search" placeholder="搜索姓名或人物编号" autocomplete="off" />
    <details>
      <summary>选择人物（已选 {{ modelValue.length }} 人）</summary>
      <ul>
        <li v-for="person in results" :key="person.id"><button type="button" @click="add(person.id)">{{ name(person) }} <small>{{ person.id.slice(0, 8) }}</small></button></li>
      </ul>
      <p v-if="!results.length">没有匹配的人物</p>
      <small v-else>最多显示 30 项，可输入姓名缩小范围。</small>
    </details>
  </div>
</template>
<style scoped>
.person-picker { display: grid; gap: .5rem; }
.person-picker__selected { display: flex; flex-wrap: wrap; gap: .35rem; }
.person-picker__selected button { border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: .25rem .5rem; background: var(--color-surface); }
input { width: 100%; }
ul { list-style: none; padding: 0; max-height: 12rem; overflow: auto; margin: .5rem 0; }
li button { width: 100%; text-align: left; padding: .45rem; border: 0; background: transparent; }
li button:hover { background: var(--color-background); }
small { color: var(--color-muted); }
summary { cursor: pointer; font-size: .85rem; color: var(--color-primary); }
</style>
