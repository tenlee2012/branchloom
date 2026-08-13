import {
  createMemoryHistory,
  createRouter,
  createWebHistory,
  type Router,
  type RouteRecordRaw,
} from 'vue-router'
import { updateWindowTitle } from './windowTitle'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: () => import('./layouts/HomeLayout.vue'),
    children: [
      {
        path: '',
        name: 'home',
        component: () => import('../features/projects/views/ProjectEntryView.vue'),
        meta: {
          title: '打开家谱',
          eyebrow: '正在进入最近项目',
        },
      },
      {
        path: 'new',
        name: 'new-project',
        component: () => import('../features/projects/views/NewProjectView.vue'),
        meta: { title: '新建家谱', eyebrow: '建立一份新的家族档案' },
      },
      {
        path: 'github-import',
        name: 'github-import',
        component: () => import('../features/collaboration/views/GithubProjectImportView.vue'),
        meta: {
          title: '从 GitHub 导入',
          eyebrow: '加入已有家族档案',
          parent: { name: 'home', label: '返回首页' },
        },
      },
      {
        path: 'import/:format',
        name: 'import-project',
        component: () => import('../features/exchange/views/ExchangeView.vue'),
        meta: {
          title: '导入家谱',
          eyebrow: '预览并整理外部资料',
          parent: { name: 'home', label: '返回首页' },
        },
      },
    ],
  },
  {
    path: '/ai-tools',
    component: () => import('./layouts/ProjectLayout.vue'),
    children: [
      {
        path: '',
        name: 'ai-tools',
        component: () => import('../features/ai-tools/views/AiToolsView.vue'),
        meta: {
          title: 'AI 工具',
          eyebrow: '本机 AI 集成',
          allowMissingProject: true,
          workspaceMode: 'management',
        },
      },
    ],
  },
  {
    path: '/project/:projectId',
    component: () => import('./layouts/ProjectLayout.vue'),
    children: [
      {
        path: 'tree',
        name: 'project-tree',
        component: () => import('../features/tree/views/TreeView.vue'),
        meta: { title: '家谱树', eyebrow: '家族关系工作区', workspaceMode: 'canvas' },
      },
      {
        path: 'people',
        name: 'project-people',
        component: () => import('../features/people/views/PeopleView.vue'),
        meta: { title: '人物', eyebrow: '人物档案与检索' },
      },
      {
        path: 'people/new',
        name: 'person-new',
        component: () => import('../features/people/views/PersonEditView.vue'),
        meta: {
          title: '新建人物',
          eyebrow: '建立人物档案',
          backBehavior: 'history',
          parent: {
            name: 'project-people',
            label: '返回人物列表',
            inheritParams: ['projectId'],
          },
        },
      },
      {
        path: 'people/:personId',
        name: 'person-detail',
        component: () => import('../features/people/views/PersonDetailView.vue'),
        meta: {
          title: '人物详情',
          eyebrow: '生平、关系与资料',
          backBehavior: 'history',
          parent: {
            name: 'project-people',
            label: '返回人物列表',
            inheritParams: ['projectId'],
          },
        },
      },
      {
        path: 'people/:personId/edit',
        name: 'person-edit',
        component: () => import('../features/people/views/PersonEditView.vue'),
        meta: {
          title: '编辑人物',
          eyebrow: '修改人物档案',
          backBehavior: 'history',
          parent: {
            name: 'person-detail',
            label: '返回人物详情',
            inheritParams: ['projectId', 'personId'],
          },
        },
      },
      {
        path: 'timeline',
        name: 'project-timeline',
        component: () => import('../features/timeline/views/TimelineView.vue'),
        meta: { title: '时间线', eyebrow: '沿时间阅读家族故事' },
      },
      {
        path: 'sources',
        name: 'project-sources',
        component: () => import('../features/sources/views/SourcesView.vue'),
        meta: { title: '资料来源', eyebrow: '证据、引用与附件' },
      },
      {
        path: 'collaboration-sync',
        name: 'project-collaboration-sync',
        component: () => import('../features/collaboration/views/CollaborationSyncView.vue'),
        meta: {
          title: '协作同步',
          eyebrow: 'GitHub 异步协作',
          workspaceMode: 'management',
        },
      },
      {
        path: 'ai-tools',
        name: 'project-ai-tools',
        component: () => import('../features/ai-tools/views/AiToolsView.vue'),
        meta: {
          title: 'AI 工具',
          eyebrow: '本机 AI 集成',
          workspaceMode: 'management',
        },
      },
      {
        path: 'manage/overview',
        name: 'project-overview',
        component: () => import('../features/projects/views/ProjectOverviewView.vue'),
        meta: { title: '项目概览', eyebrow: '项目管理', workspaceMode: 'management' },
      },
      {
        path: 'manage/new',
        name: 'project-new',
        component: () => import('../features/projects/views/NewProjectView.vue'),
        meta: {
          title: '新建项目',
          eyebrow: '项目管理',
          workspaceMode: 'management',
          parent: {
            name: 'project-overview',
            label: '返回项目管理',
            inheritParams: ['projectId'],
          },
        },
      },
      {
        path: 'manage/exchange',
        name: 'project-exchange',
        component: () => import('../features/exchange/views/ExchangeView.vue'),
        meta: {
          title: '导入与导出',
          eyebrow: '项目管理',
          workspaceMode: 'management',
          parent: {
            name: 'project-overview',
            label: '返回项目管理',
            inheritParams: ['projectId'],
          },
        },
      },
      {
        path: 'manage/history',
        name: 'project-history',
        component: () => import('../features/maintenance/views/HistoryView.vue'),
        meta: {
          title: '备份与历史',
          eyebrow: '项目管理',
          workspaceMode: 'management',
          parent: {
            name: 'project-overview',
            label: '返回项目管理',
            inheritParams: ['projectId'],
          },
        },
      },
      {
        path: 'manage/checks',
        name: 'project-checks',
        component: () => import('../features/maintenance/views/ChecksView.vue'),
        meta: {
          title: '数据检查与维护',
          eyebrow: '项目管理',
          workspaceMode: 'management',
          parent: {
            name: 'project-overview',
            label: '返回项目管理',
            inheritParams: ['projectId'],
          },
        },
      },
      {
        path: 'manage/settings',
        name: 'project-settings',
        component: () => import('../features/projects/views/ProjectSettingsView.vue'),
        meta: {
          title: '项目设置',
          eyebrow: '项目管理',
          workspaceMode: 'management',
          parent: {
            name: 'project-overview',
            label: '返回项目管理',
            inheritParams: ['projectId'],
          },
        },
      },
    ],
  },
]

export function createAppRouter(history: 'web' | 'memory' = 'web'): Router {
  const router = createRouter({
    history: history === 'memory' ? createMemoryHistory() : createWebHistory(),
    routes,
    scrollBehavior: () => ({ top: 0 }),
  })

  router.beforeEach((to, from) => {
    if (to.meta.backBehavior === 'history' && from.name) {
      to.meta.previousFullPath = from.fullPath
    }
  })

  router.afterEach((to) => {
    updateWindowTitle(to.meta.title)
  })

  return router
}
