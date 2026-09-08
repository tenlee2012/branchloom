import { describe, expect, it } from 'vitest'
import { exchangeDestination, exchangeErrorMessage, exchangeFileName, selectedFileName } from './exchangeFile'

describe('exchange file names', () => {
  it('preserves opaque provider URIs while completing desktop file extensions', () => {
    for (const extension of ['blp', 'ged'] as const) {
      const uri = 'content://com.android.providers.downloads.documents/document/123%3A456'
      expect(exchangeDestination(uri, extension)).toBe(uri)
      expect(exchangeDestination('file:///private/family%20archive', extension))
        .toBe('file:///private/family%20archive')
      expect(exchangeDestination('/tmp/family', extension)).toBe(`/tmp/family.${extension}`)
      expect(exchangeDestination(`C:\\family.${extension.toUpperCase()}`, extension))
        .toBe(`C:\\family.${extension.toUpperCase()}`)
    }
  })

  it('uses only the final file name in user notifications', () => {
    expect(selectedFileName('/Users/example/Private/family.ged')).toBe('family.ged')
    expect(selectedFileName('C:\\Users\\example\\Private\\family.blp')).toBe('family.blp')
  })

  it('creates a safe default export name', () => {
    expect(exchangeFileName('林氏/家谱', 'ged')).toBe('林氏-家谱.ged')
    expect(exchangeFileName('  ', 'blp')).toBe('有谱项目.blp')
  })

  it('preserves string errors returned by Tauri', () => {
    expect(exchangeErrorMessage('无法导出 GEDCOM 文件：文件已存在', '导出失败')).toBe(
      '无法导出 GEDCOM 文件：文件已存在',
    )
    expect(exchangeErrorMessage(new Error('磁盘空间不足'), '导出失败')).toBe('磁盘空间不足')
    expect(exchangeErrorMessage(null, '导出失败')).toBe('导出失败')
  })
})
