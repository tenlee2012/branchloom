export type LongTaskStage =
  | 'idle'
  | 'processing'
  | 'committing'
  | 'complete'
  | 'failed'
  | 'cancelled'

export interface LongTaskState {
  stage: LongTaskStage
  phase: string
  progress: number
  report: string[]
  failureMessage?: string
}

export function createLongTaskState(): LongTaskState {
  return { stage: 'idle', phase: '等待开始', progress: 0, report: [] }
}

function cloneLongTask(state: LongTaskState): LongTaskState {
  return { ...state, report: [...state.report] }
}

export function startLongTask(state: LongTaskState): LongTaskState {
  if (state.stage !== 'idle' && state.stage !== 'failed') return cloneLongTask(state)
  return { stage: 'processing', phase: '准备与预检', progress: 10, report: [] }
}

export function advanceLongTask(state: LongTaskState): LongTaskState {
  if (state.stage !== 'processing') return cloneLongTask(state)
  if (state.progress < 40) {
    return { ...cloneLongTask(state), phase: '分析影响范围', progress: 40 }
  }
  return { ...cloneLongTask(state), stage: 'committing', phase: '原子写入', progress: 90 }
}

export function completeLongTask(state: LongTaskState, report: string[]): LongTaskState {
  return { ...cloneLongTask(state), stage: 'complete', phase: '完成', progress: 100, report: [...report], failureMessage: undefined }
}

export function failLongTask(state: LongTaskState, message: string): LongTaskState {
  const details = message.trim() || '任务失败'
  return { ...cloneLongTask(state), stage: 'failed', phase: '失败', failureMessage: details, report: [...state.report, details] }
}

export function cancelLongTask(state: LongTaskState): LongTaskState {
  if (!canCancelLongTask(state)) return cloneLongTask(state)
  return { ...cloneLongTask(state), stage: 'cancelled', phase: '已安全取消' }
}

export function canCancelLongTask(state: LongTaskState): boolean {
  return state.stage === 'idle' || state.stage === 'processing'
}
