import { createHash } from 'node:crypto'

export function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

export function createFileHashManifest(files) {
  const orderedFiles = [...files]
    .sort((left, right) => compareUtf8(left.path, right.path))
  const digest = createHash('sha256')

  for (const file of orderedFiles) {
    digest.update(file.path).update('\0').update(file.sha256).update('\n')
  }

  return {
    sha256: digest.digest('hex'),
    files: orderedFiles,
  }
}
