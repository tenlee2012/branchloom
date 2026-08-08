export function exchangeFileName(name: string, extension: 'blp' | 'ged'): string {
  const safeName = name.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\.+$/g, '') || '有谱项目'
  return `${safeName}.${extension}`
}

export function selectedFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? '导出文件'
}

export function exchangeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  if (error && typeof error === 'object' && 'message' in error) {
    const message = Reflect.get(error, 'message')
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  return fallback
}
