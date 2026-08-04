import { createDemoState } from '../fixtures/demoState'
import {
  cloneValue,
  createSnapshotPayloads,
  type SnapshotPayloads,
} from './storage'

const CANONICAL_DEMO_SNAPSHOT_PAYLOADS = createSnapshotPayloads(createDemoState())

export function createCanonicalDemoSnapshotPayloads(): SnapshotPayloads {
  return cloneValue(CANONICAL_DEMO_SNAPSHOT_PAYLOADS)
}
