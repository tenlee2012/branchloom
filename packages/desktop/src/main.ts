import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { createAppRouter } from './app/router'
import {
  createRuntimeRepository,
  installBranchloomRepository,
} from './shared/repository/injection'
import { resolveInitialRoute } from './app/startup'
import { BrowserRecentProjectLocations } from './features/projects/model/recentProjectLocations'
import { startNativeRepositoryRefresh } from './shared/repository/TauriRepository'
import './app/styles/tokens.css'
import './app/styles/base.css'

async function bootstrap() {
  const repository = await createRuntimeRepository()
  const recentProjectLocations = new BrowserRecentProjectLocations()
  const router = createAppRouter()
  const initialRoute = await resolveInitialRoute({
    repository,
    currentPath: window.location.pathname,
    recentProjectIds: recentProjectLocations.list().map(({ projectId }) => projectId),
  })
  if (initialRoute) await router.push(initialRoute)

  const app = createApp(App)
  app.use(createPinia())
  app.use(router)
  installBranchloomRepository(app, repository)
  app.mount('#app')
  const stopNativeRefresh = startNativeRepositoryRefresh(repository)
  window.addEventListener('beforeunload', stopNativeRefresh, { once: true })
}

function renderBootstrapFailure(error: unknown) {
  const root = document.querySelector('#app')
  if (!root) return
  const main = document.createElement('main')
  main.className = 'bootstrap-failure'
  main.setAttribute('role', 'alert')
  const eyebrow = document.createElement('p')
  eyebrow.textContent = '本地资料无法打开'
  const title = document.createElement('h1')
  title.textContent = '有谱未能启动'
  const description = document.createElement('p')
  description.textContent = error instanceof Error
    ? error.message
    : '请重新启动应用；如果问题持续，请保留本地数据目录并联系支持。'
  main.append(eyebrow, title, description)
  root.replaceChildren(main)
}

void bootstrap().catch(renderBootstrapFailure)
