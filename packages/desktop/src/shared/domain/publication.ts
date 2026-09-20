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
  cover: '封面', preface: '谱序', contents: '目录', tree: '世系图', biographies: '人物传记',
  events: '家族大事记', sources: '史料来源', appendices: '史料附录', index: '姓名索引',
}
export const fieldLabels: Record<string, string> = {
  names: '其他姓名', status: '在世状态', dates: '生卒时间', places: '生卒地点', biography: '生平',
  notes: '备注', relationships: '亲属关系', careers: '职业履历', titles: '称谓', photos: '人物照片', citations: '引用与摘录',
}
export function newPublicationPlan(title: string, format: PublicationFormat = 'modern'): PublicationPlan {
  return {
    id: crypto.randomUUID(), name: format === 'modern' ? '现代谱册' : format === 'traditional' ? '传统谱册' : '世系挂图',
    format, title, subtitle: '', editor: '', edition: '', date: new Date().toLocaleDateString('sv-SE'), preface: '',
    scope: { mode: 'all', roots: [], generations: null, startGeneration: 1, partners: true, parentTypes: ['biological', 'adoptive', 'step', 'guardian'], exclude: [] },
    chapters: Object.keys(chapterLabels) as PublicationChapter[], fields: Object.keys(fieldLabels).filter((key) => key !== 'notes'),
    paper: { widthMm: 210, heightMm: 297, marginMm: 18, gutterMm: 8, fontSize: format === 'traditional' ? 14 : 12, duplex: true },
    chart: { tiled: true, fontSize: 10, overlapMm: 5 }, coverAttachmentId: null, images: [], appendices: [],
  }
}
