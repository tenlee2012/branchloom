import { inject, type App, type InjectionKey } from 'vue'
import type { BranchloomRepository } from '../domain/types'
import { BrowserPrototypeRepository } from './BrowserPrototypeRepository'
import { createTauriRepository, tauriStateGateway, webStateGateway } from './TauriRepository'

export const branchloomRepositoryKey: InjectionKey<BranchloomRepository> = Symbol('BranchloomRepository')

export function createDefaultRepository(): BranchloomRepository {
  return new BrowserPrototypeRepository()
}

export async function createRuntimeRepository(): Promise<BranchloomRepository> {
  const { isTauri } = await import('@tauri-apps/api/core')
  return createTauriRepository(isTauri() ? tauriStateGateway : webStateGateway)
}

export function provideBranchloomRepository(app: App, repository: BranchloomRepository): App {
  app.provide(branchloomRepositoryKey, repository)
  return app
}

export const installBranchloomRepository = provideBranchloomRepository

export function useBranchloomRepository(): BranchloomRepository {
  const repository = inject(branchloomRepositoryKey)
  if (!repository) {
    throw new Error('BranchloomRepository has not been provided')
  }
  return repository
}
