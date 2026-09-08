# AGENTS.md

本文件约束 Branchloom 仓库开发；子目录的 `AGENTS.md` 补充或覆盖对应范围。安装后的家谱数据操作见 [Branchloom Skill](skills/branchloom/SKILL.md)，不要把数据操作流程套用到源码或文档审计。

Branchloom（有谱）是本地优先的家谱与家庭资料管理应用：`packages/core` 提供共享 Rust 核心与存储，`packages/desktop` 提供 Vue 3 / Tauri 2 界面，`packages/cli` 提供原生 CLI 与协议测试，`skills/branchloom` 提供随桌面版分发的技能。用户界面和产品文案以简体中文为主。

## 授权与工作范围

- 根据完整请求和已有上下文区分讨论与实施。仅表达想法或探索方案（如尚未要求实施的“考虑增加”“帮我设计”）时，只做必要的只读检查，不修改代码或配置。
- 新产品或功能在实现前给出需求草案：目标与场景、首版范围与非目标、接口或命令示例、数据读写与安全策略、验收标准、未决问题。讨论阶段等待“开始实现”或同等明确指令；已明确要求实现、修改、修复或优化的任务，直接完成授权范围内的工作，无需重复索取授权。
- 用户的明确请求及已有授权优先于本文件和 Skill 中的一般流程建议。常规实施选择自行处理；只有答案会影响范围、正确性或授权时才澄清。需要扩大范围时暂停相关部分，先把已授权且不依赖答复的工作做成可审阅结果。
- 因指令而暂停或请求确认时，说明具体动作，链接并引用触发暂停的文件条款，区分明确要求与自己的推断。实施授权不替代下述数据安全与 CLI 校验。
- 开始前检查 `git status --short`，保留用户已有改动；阅读 [README.md](README.md)、相关 package 配置和目标代码，格式相关任务再读 [DATA_FORMAT.md](DATA_FORMAT.md)。同一任务无需反复读取未变化的文档。
- 只修改任务必需文件，不顺手重构或升级依赖。新增依赖需说明必要性，避免无关 feature；锁文件仅随经确认的依赖变化更新。不手工编辑 `dist`、`target`、`node_modules`、Playwright 报告或暂存二进制等生成物。
- 未经用户明确要求，不创建分支、提交、推送、发布或操作真实 GitHub 仓库。
- 优先用 `rg` / `rg --files` 定位；如涉及 Go，使用 `trae-gopls`，不用 `gopls-lsp`。

## 架构与存储

- 持久化业务规则属于 `branchloom-core::ApplicationService` 或其下层。SQLite Schema 与迁移只维护在 `packages/core/migrations`；桌面与 CLI 共用数据目录解析、实体校验、附件语义、导入导出及存储实现。
- Vue 页面与 composable 通过 `BranchloomRepository` 访问业务数据，不直接访问 SQLite、附件目录、Tauri internals 或调用 `window.fetch`。`TauriRepository`、Tauri commands 与 Web bridge 保持薄适配层，不复制验证、事务或合并规则。
- Web 开发模式通过本机受令牌保护的数据桥访问共享核心；不使用 `localStorage` 作为正式数据源。CLI 与 Skill 随桌面安装包携带，通过“AI 工具”页面安装，不恢复 npm/npx 用户安装链路。
- Rust 错误通过 `CoreError` / `CoreResult` 传播，不对用户输入或外部状态 `unwrap`。多实体写入在单个 SQLite 事务内完成，失败不留部分状态。
- Schema 变化新增向前迁移，不改写已发布迁移，并覆盖新建库与升级库。保持 UUID、时间戳、revision、change-set 和项目作用域校验一致。
- 导入、导出和同步遵守 `DATA_FORMAT.md` 的确定性顺序、路径及附件约定；GitHub 同步先 Pull，再做字段级三方合并，未解决冲突时不得 Push。
- 新增核心能力时评估桌面适配、CLI 合约、Skill 文档和测试；只更新受影响的部分。

## 数据安全

- 仓库开发与测试不得操作真实用户数据，也不得读取默认应用数据目录。使用 `tempfile`、`mktemp -d`、测试夹具或隔离测试库；CLI 测试显式传 `--data-dir` 或隔离的 `--profile`。
- 不直接编辑 `branchloom.sqlite3`、用户附件目录或 GitHub 同步基线。真实人物资料、访问令牌、钥匙串内容和用户本地路径不得进入日志、快照、测试或提交。
- GitHub token 仅通过环境变量或系统安全凭据存储传递，不进入项目数据、`.blp` 或 JSON-LD 工作树。附件由共享核心复制、哈希、去重；业务记录不保存用户原始文件路径。
- 所有业务实体当前为硬删除。删除路径必须说明影响范围并保留危险操作确认，不假设存在回收站。
- 允许非常规亲属关系，包括自关系与环；不得擅自增加家谱合理性限制。地点与机构的层级约束不因此改变。

## CLI 合约

- 公共机器协议为 contract version `3`。修改 envelope、错误码、字段、capability 或命令语义时，显式评估兼容性；命令与输入详情见 [CLI reference](skills/branchloom/references/cli-reference.md)。
- `--output json` 的 stdout 仅包含一个 JSON envelope；额外诊断只写 stderr。
- 写操作无 `--apply` 时预览，提交必须携带同一计划的 `--if-match <etag>`；不提供 `--preview` 或隐式绕过预览的写入。删除、关系变更等高风险操作还须校验预览返回的 `destructiveConfirmation`。
- 复杂输入只接受绝对路径 JSON 文件，不接受 stdin。`--project` 是权威作用域，输入不带系统字段。实体写入成功返回可追踪的 `changeSetId`，并发变化产生 revision 或 etag 冲突。
- 人物与关系原子批次仅支持已公布的 `person/create` 与 `relationship/add`；不得静默拆成多个非原子写入。
- 命令、Schema 或安全流程变化时，同步更新 [CLI README](packages/cli/README.md)、[SKILL.md](skills/branchloom/SKILL.md) 和相关 references 的受影响内容；行为覆盖变化时更新 [evals.json](skills/branchloom/evals/evals.json)。

## 前端约定

- 使用 Vue 3 Composition API、TypeScript 和现有设计系统组件。路由按 feature 懒加载，业务代码放在 `packages/desktop/src/features/<feature>`；共享纯规则放 `src/shared/domain`，跨页面数据访问放 repository 或 store。
- 所有项目页面由 `ProjectLayout` 提供 `AppSidebar`、`AppTopbar` 和独立滚动内容区；不得用 `contentOnly`、条件渲染或自建外壳隐藏、绕过全局顶部栏。
- 页面只声明内容区形态，默认保留“刷新资料”等全局能力。标题放内容区，返回入口、全局操作和少量页面级操作放顶部栏。
- 修改项目路由或基础框架时补充框架级回归测试，覆盖现有与新增页面的统一外壳、窄屏、键盘操作和无障碍语义。
- 异步流程覆盖 loading、empty、error 与成功反馈，危险操作提供预览与确认。保留可见焦点、语义标签、`aria-*` 和窄屏布局；中文文案变化时核对相关组件测试与端到端断言。

## 验证与交付

按影响选择最小充分检查，完成相关要求后停止；仅在新修改、失败或未解决问题需要时扩大或重复验证。修复缺陷优先补充能复现问题的回归测试，不为低影响文档或措辞调整新增仅匹配文字的测试，不削弱产品校验来通过测试。

| 改动范围 | 检查 |
| --- | --- |
| 文档、Skill、references | 链接与示例、frontmatter / JSON、协议与授权一致性；按需使用隔离 CLI 验证，不默认跑全量应用测试 |
| 前端类型或组件 | `pnpm typecheck`、`pnpm test:unit` |
| 共享核心或 CLI | `pnpm test:cli`；跨 workspace 影响时加 `cargo test --workspace` |
| 用户关键流程 | `pnpm test:e2e` |
| Rust 静态与格式 | `cargo fmt --all -- --check`；按影响运行 `cargo check --workspace`、`cargo clippy --workspace --all-targets -- -D warnings` |
| 发布相关 | 核对 tag、根版本、Rust CLI Cargo 版本、AI tools manifest 与 `tauri.conf.json` 的版本关系 |

`README.md` 只描述可验证的当前能力与命令，不链接不存在的规格；格式行为变化同步更新 `DATA_FORMAT.md`。交付时简要说明修改文件、验证结果、未运行项及原因和剩余风险。
