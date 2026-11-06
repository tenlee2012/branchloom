import { t } from '../i18n'
import type { Attachment, PersonName, Project } from './types'

export type PublicationFormat = 'modern' | 'traditional' | 'chart'
export type PublicationChapter = 'cover' | 'preface' | 'contents' | 'tree' | 'biographies' | 'events' | 'sources' | 'appendices' | 'index'
export interface PublicationPlan {
  id: string
  name: string
  format: PublicationFormat
  title: string
  subtitle: string
  editor: string
  edition: string
  date: string
  preface: string
  scope: {
    mode: 'all' | 'branch' | 'ancestors' | 'descendants'
    roots: string[]
    generations: number | null
    startGeneration: number
    partners: boolean
    parentTypes: string[]
    exclude: string[]
  }
  chapters: PublicationChapter[]
  fields: string[]
  paper: { widthMm: number; heightMm: number; marginMm: number; gutterMm: number; fontSize: number; duplex: boolean }
  chart: { tiled: boolean; fontSize: number; overlapMm: number }
  coverAttachmentId: string | null
  images: Array<{ attachmentId: string; personId: string | null; caption: string }>
  appendices: Array<{ attachmentId: string; pages: string }>
}

export interface PublicationRequest {
  operation: 'context' | 'savePlan' | 'deletePlan' | 'start' | 'status' | 'report' | 'read' | 'cancel' | 'release' | 'pdfInfo'
  projectId: string
  jobId?: string
  plan?: PublicationPlan
  planId?: string
  expectedRevision?: number
  attachmentId?: string
  offset?: number
  length?: number
}
export interface PublicationPerson { id: string; names: PersonName[] }
export interface PublicationContext { revision: number; project: Project; people: PublicationPerson[]; attachments: Attachment[] }
export interface PublicationStatus {
  state: 'running' | 'ready' | 'failed' | 'cancelled'
  stage: string
  completed: number
  total: number
  revision: number
  pages: number
  bytes: number
  error: string | null
  stale: boolean
}
export interface PublicationReport {
  people: number
  relationships: number
  branches: number
  pages: number
  bytes: number
  elapsedMs: number
  entries: Array<{ id: string; name: string; number: number; generation: number | null; branch: number; page: number | null }>
  excluded: Array<{ id: string; reason: string }>
  issues: Array<{ code: string; message: string; targetId: string }>
}

export const chapterLabels: Record<PublicationChapter, string> = {
  get cover() { return t('封面') }, get preface() { return t('谱序') }, get contents() { return t('目录') }, get tree() { return t('世系图') }, get biographies() { return t('人物传记') },
  get events() { return t('家族大事记') }, get sources() { return t('史料来源') }, get appendices() { return t('史料附录') }, get index() { return t('姓名索引') },
}
export const fieldLabels: Record<string, string> = {
  get names() { return t('其他姓名') }, get status() { return t('在世状态') }, get dates() { return t('生卒时间') }, get places() { return t('生卒地点') }, get biography() { return t('生平') },
  get notes() { return t('备注') }, get relationships() { return t('亲属关系') }, get careers() { return t('职业履历') }, get titles() { return t('称谓') }, get photos() { return t('人物照片') }, get citations() { return t('引用与摘录') },
}
export function newPublicationPlan(title: string, format: PublicationFormat = 'modern'): PublicationPlan {
  return {
    id: crypto.randomUUID(), name: format === 'modern' ? t('现代谱册') : format === 'traditional' ? t('传统谱册') : t('世系挂图'),
    format, title, subtitle: '', editor: '', edition: '', date: new Date().toLocaleDateString('sv-SE'), preface: '',
    scope: { mode: 'all', roots: [], generations: null, startGeneration: 1, partners: true, parentTypes: ['biological', 'adoptive', 'step', 'guardian'], exclude: [] },
    chapters: Object.keys(chapterLabels) as PublicationChapter[], fields: Object.keys(fieldLabels).filter((key) => key !== 'notes'),
    paper: { widthMm: 210, heightMm: 297, marginMm: 18, gutterMm: 8, fontSize: format === 'traditional' ? 14 : 12, duplex: true },
    chart: { tiled: true, fontSize: 10, overlapMm: 5 }, coverAttachmentId: null, images: [], appendices: [],
  }
}
