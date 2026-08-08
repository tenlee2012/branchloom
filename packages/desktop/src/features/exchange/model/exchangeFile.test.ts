import { describe, expect, it } from 'vitest'
import { exchangeErrorMessage, exchangeFileName, selectedFileName } from './exchangeFile'

describe('exchange file names', () => {
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
