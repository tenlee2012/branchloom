import { describe, expect, it } from 'vitest'
import { isPlaceCoordinates, parsePlaceCoordinates } from './placeCoordinates'

describe('place GPS coordinates', () => {
  it('leaves legacy coordinates empty and preserves zero, signs and decimal precision', () => {
    expect(parsePlaceCoordinates(' ', '')).toBeUndefined()
    expect(parsePlaceCoordinates(' 26.0745 ', '119.2965')).toEqual({ latitude: 26.0745, longitude: 119.2965 })
    expect(parsePlaceCoordinates('0', '0')).toEqual({ latitude: 0, longitude: 0 })
    expect(parsePlaceCoordinates('-33.86882', '+151.209296')).toEqual({ latitude: -33.86882, longitude: 151.209296 })
    expect(parsePlaceCoordinates('-90', '-180')).toEqual({ latitude: -90, longitude: -180 })
    expect(parsePlaceCoordinates('90', '180')).toEqual({ latitude: 90, longitude: 180 })
    expect(parsePlaceCoordinates('1e-7', '-1e-7')).toEqual({ latitude: 0.0000001, longitude: -0.0000001 })
  })

  it.each([
    ['26', '', '同时填写'],
    ['', '119', '同时填写'],
    ['91', '119', '纬度必须'],
    ['-91', '119', '纬度必须'],
    ['26', '181', '经度必须'],
    ['26', '-181', '经度必须'],
    ['北纬26度', '119', '十进制度'],
    ['0x10', '119', '十进制度'],
    ['NaN', '119', '十进制度'],
    ['26', 'Infinity', '十进制度'],
  ])('rejects invalid coordinate input (%s, %s)', (latitude, longitude, error) => {
    expect(() => parsePlaceCoordinates(latitude, longitude)).toThrow(error)
  })

  it('rejects invalid persisted coordinate values', () => {
    expect(isPlaceCoordinates({ latitude: 0, longitude: 0 })).toBe(true)
    for (const coordinates of [
      null, [], {}, { latitude: 26 }, { longitude: 119 },
      { latitude: '26', longitude: 119 }, { latitude: 26, longitude: null },
      { latitude: NaN, longitude: 119 }, { latitude: 26, longitude: Infinity },
      { latitude: 91, longitude: 119 }, { latitude: 26, longitude: -181 },
      { latitude: 26, longitude: 119, crs: 'GCJ02' },
    ]) {
      expect(isPlaceCoordinates(coordinates)).toBe(false)
    }
  })
})
