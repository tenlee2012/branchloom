import type { PlaceCoordinates } from './types'

export function isPlaceCoordinates(value: unknown): value is PlaceCoordinates {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).every((key) => key === 'latitude' || key === 'longitude')
    && typeof record.latitude === 'number' && Number.isFinite(record.latitude) && Math.abs(record.latitude) <= 90
    && typeof record.longitude === 'number' && Number.isFinite(record.longitude) && Math.abs(record.longitude) <= 180
}

export function parsePlaceCoordinates(latitude: string, longitude: string): PlaceCoordinates | undefined {
  const lat = latitude.trim()
  const lon = longitude.trim()
  if (!lat && !lon) return undefined
  if (!lat || !lon) throw new Error('请同时填写经度和纬度，或将两项一起留空。')
  const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u
  if (!decimal.test(lat) || !decimal.test(lon)) throw new Error('经度和纬度请输入十进制度数字。')
  const coordinates = { latitude: Number(lat), longitude: Number(lon) }
  if (!Number.isFinite(coordinates.latitude) || Math.abs(coordinates.latitude) > 90) {
    throw new Error('纬度必须在 -90 到 90 之间。')
  }
  if (!Number.isFinite(coordinates.longitude) || Math.abs(coordinates.longitude) > 180) {
    throw new Error('经度必须在 -180 到 180 之间。')
  }
  return coordinates
}
