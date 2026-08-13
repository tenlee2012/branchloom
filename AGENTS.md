# AGENTS.md

本文件适用于整个 Branchloom 仓库。更深层目录若新增自己的 `AGENTS.md`，以更具体的规则为补充或覆盖。

## 项目定位

Branchloom（有谱）是本地优先的家谱与家庭资料管理应用。仓库包含：

- `packages/core`：共享 Rust 业务核心、SQLite 存储、项目格式、附件和 GitHub 同步。
- `packages/desktop`：Vue 3 前端和 Tauri 2 桌面外壳。
- `packages/cli`：原生 Rust CLI、协议测试和开发文档。
- `skills/branchloom`：供 Agent 使用的 Branchloom Skill 与 CLI 机器协议说明。

面向用户的界面和产品文案以简体中文为主；代码标识符、协议字段和提交信息可沿用现有英文风格。

## 需求与实施流程

- 当用户说“我想做”“考虑增加”“帮我设计”等表达想法或探索方案时，默认处于需求讨论阶段，不得将其视为代码实施授权。
- 需求讨论阶段只允许进行必要的只读检查，不得新增、修改或删除代码及配置。
- 对新增产品或功能，在实现前先输出需求草案，至少包含：
  - 目标与用户场景
  - 首版范围与非目标
  - 接口或命令示例
  - 数据读写与安全策略
  - 验收标准
  - 未决问题
- 必须等待用户明确表示“开始实现”或给出同等明确的实施指令后，才能修改代码。
- 如果用户最初已经明确要求实现、修改或修复代码，则无需重复请求实施授权。
- 实现过程中发现需要扩大已确认范围时，暂停实施并重新确认。
- 不得操作真实用户数据；测试必须使用临时数据、测试夹具或测试数据库。

## 开始工作前

1. 先阅读根 `README.md`、相关 package 配置和目标代码；涉及数据格式时阅读 `DATA_FORMAT.md`。
2. 检查 `git status --short`，保留用户已有改动，不覆盖、不回退无关文件。
3. 优先使用 `rg` / `rg --files` 定位代码。
4. Go 语言分析或编辑必须使用 `trae-gopls`，不要使用 `gopls-lsp`。
5. 只修改完成当前任务必需的文件；不要顺手重构或升级依赖。

## 架构不变量

- 所有持久化业务规则必须进入 `branchloom-core::ApplicationService` 或其下层模块。
- SQLite Schema 和迁移只维护在 `packages/core/migrations`；桌面端和 CLI 不得各自实现数据库逻辑。
- Vue 页面与 composable 只依赖 `BranchloomRepository`，不得直接访问 SQLite、附件目录或 Tauri internals。
- `TauriRepository`、Tauri commands 和 Web bridge 保持为薄适配层，不复制验证、事务或合并规则。
- CLI 与 Skill 由桌面安装包携带，并通过桌面端“AI 工具”页面安装；不得恢复 npm/npx 用户安装链路。
- Web 开发模式只能通过本机受令牌保护的数据桥访问共享核心；不得退回 `localStorage` 作为正式数据源。
- CLI 与桌面端必须使用相同的数据目录解析、实体校验、附件语义和项目导入导出实现。
- 新增核心能力时，同时评估桌面适配、CLI 合约、Skill 文档和测试是否需要更新。

## 数据与安全

- 永远不要直接编辑 `branchloom.sqlite3`、用户附件目录或 GitHub 同步基线。
- 自动化测试必须使用 `tempfile`、`mktemp -d`、测试夹具或显式隔离的 `--profile`。
- 不得把真实人物资料、访问令牌、钥匙串内容或用户本地路径写入日志、快照、测试或提交。
- GitHub token 只通过环境变量或系统安全凭据存储传递，不得进入项目数据、`.blp` 或 JSON-LD 工作树。
- 附件通过共享核心复制、哈希和去重；业务记录不得保存用户原始文件路径。
- 所有业务实体当前使用硬删除。新增删除路径时必须明确影响范围并保留危险操作确认，不得假设存在回收站。
- Branchloom 允许非常规关系，包括自关系和环；不要擅自增加“看起来合理”的家谱约束。

## CLI 合约

- 公共机器协议当前为 contract version `3`；若修改 envelope、错误码、字段、capability 或命令语义，必须显式评估版本兼容性。
- `--output json` 的 stdout 必须只包含一个 JSON envelope；诊断信息写入 stderr。
- 写操作保持两阶段：无 `--apply` 时预览，提交时要求同一计划的 `--if-match <etag>`。
- CLI 不提供 `--preview` 参数，不得新增绕过预览的隐式写入。
- 删除、关系变更和其他高风险操作还必须校验预览返回的 `destructiveConfirmation`。
- 复杂输入只接受绝对路径 JSON 文件；不支持 stdin。`--project` 是权威作用域，输入不得带系统字段。
- 写入成功应返回可追踪的 `changeSetId`；并发变化必须产生 revision 或 etag 冲突。
- 人物与关系原子批次只支持已公布的 `person/create` 与 `relationship/add` 子集。不要静默拆成多个非原子写入。
- 修改命令、Schema 或安全流程时同步更新：
  - `packages/cli/README.md`
  - `skills/branchloom/SKILL.md`
  - `skills/branchloom/references/cli-reference.md`
  - `skills/branchloom/evals/evals.json`（若行为覆盖发生变化）

## 前端约定

- 使用 Vue 3 Composition API、TypeScript 和现有设计系统组件；避免在业务页面重复实现按钮、抽屉、对话框和状态样式。
- 保持路由按 feature 懒加载，业务代码放在对应 `packages/desktop/src/features/<feature>`。
- 所有项目页面必须由 `ProjectLayout` 提供统一基础框架，包括 `AppSidebar`、`AppTopbar` 和独立滚动的内容区；不得通过 `contentOnly`、条件渲染或页面自建外壳隐藏或绕过全局顶部栏。
- 新增项目页面只允许声明内容区形态（如标准文档、管理页或画布），默认必须保留“刷新资料”等全局能力；页面标题保留在内容区，返回入口、全局操作和少量页面级操作统一放在顶部栏。
- 修改项目路由或基础框架时必须补充框架级回归测试，确保现有及新增项目页面均使用统一外壳，且窄屏、键盘操作和无障碍语义不退化。
- 共享纯规则放入 `src/shared/domain`，跨页面数据访问放入 repository 或 store，不在组件内复制。
- 所有异步流程必须覆盖 loading、empty、error 和成功反馈；危险操作必须提供明确预览与确认。
- 保持键盘操作、可见焦点、语义标签、`aria-*` 和合理的窄屏布局。
- 不要在组件中直接调用 `window.fetch` 访问业务数据；网络与原生能力通过既有边界封装。
- 修改可见中文文案时检查相关组件测试和端到端断言。

## Rust 与存储约定

- 错误使用现有 `CoreError` / `CoreResult` 传播，不在核心路径 `unwrap` 用户输入或外部状态。
- 多实体写入必须在单个 SQLite 事务内完成；失败时不得留下部分状态。
- 修改 Schema 时新增向前迁移并覆盖新建库与升级库场景，不改写已发布迁移。
- 保持稳定 UUID、时间戳、revision、change-set 和项目作用域校验的一致性。
- 项目导入、导出和同步必须继续遵守 `DATA_FORMAT.md` 的确定性顺序、路径与附件约定。
- GitHub 同步始终先 Pull，再执行字段级三方合并，未解决冲突时不得 Push。
- 使用 `cargo fmt` 格式化；新增依赖前说明必要性，并避免启用无关 feature。

## 测试与验证

按改动风险运行最小充分集合：

- 前端类型或组件：`pnpm typecheck`、`pnpm test:unit`
- 共享核心或 CLI：`pnpm test:cli`，必要时 `cargo test --workspace`
- 用户关键流程：`pnpm test:e2e`
- Rust 静态检查：`cargo check --workspace`
- Rust 格式：`cargo fmt --all -- --check`
- Rust lint：`cargo clippy --workspace --all-targets -- -D warnings`
- 发布相关改动：核对 tag、根版本、Rust CLI Cargo 版本、AI tools manifest 与 `tauri.conf.json` 的版本关系

测试要求：

- 修复缺陷时优先添加能在修复前失败、修复后通过的回归测试。
- 测试不得读取默认应用数据目录；涉及 CLI 写入时必须显式传 `--data-dir` 或隔离 profile。
- 不为通过测试而削弱产品校验、安全确认或数据完整性约束。
- 如果受环境限制无法运行某项检查，在交付说明中明确列出未运行项及原因。

## 文档与提交边界

- `README.md` 只描述当前可验证的能力和命令，不链接不存在的路线图或规格文件。
- `DATA_FORMAT.md` 是开放项目格式的权威说明；格式行为变化必须同步更新。
- 不手工编辑生成物、构建目录或依赖目录，包括 `dist`、`target`、`node_modules`、Playwright 报告和暂存的原生二进制。
- 不改动锁文件，除非依赖本身发生了经确认的变化。
- 未经用户明确要求，不创建分支、提交、推送、发布或操作真实 GitHub 仓库。

## 完成标准

交付前确认：

1. 改动没有越过用户确认的范围，也没有覆盖用户已有工作。
2. 架构边界、预览确认协议和隐私约束仍然成立。
3. 相关测试已运行并通过，或已清楚说明未运行原因。
4. 用户可见行为、CLI 合约与对应文档保持一致。
5. 最终说明简要列出修改文件、验证结果和任何剩余风险。
