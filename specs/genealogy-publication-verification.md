# 族谱编印验证记录

日期：2026-09-20。对应 [规格](genealogy-publication.md)。全部使用临时 SQLite 数据库、确定性虚构家族及合成图片，不读取或修改真实用户资料。

## 实现入口

- “项目管理 → 编印族谱”，路由 `/project/:projectId/manage/publication`；旧 `/publication` 路径保留重定向。
- Rust 共享核心：`packages/core/src/publication/`；方案保存与任务调用经 `ApplicationService`。
- 界面：`packages/desktop/src/features/publication/`；PDF.js 按范围读取核心缓存的最终 PDF。
- Tauri 原生保存与 Android 文档 URI 复用 `exchange_files`。Web 数据桥用于隔离测试及开发预览。
- 方案进入项目格式 1.1.0 与 schema 6；完整 `.blp` 导入导出验证保留方案，CLI contract 3 不变。

## 自动化结果

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm test:unit` | 554 项通过，含项目管理子菜单、窄屏导航、原地刷新保留输入/焦点，以及取消离开后标题不变 |
| `pnpm build` | 通过；PDF worker、字体、CMap、解码器进入离线产物。已有家谱布局引擎大分块提示仍在 |
| `pnpm test:cli` | PDF 成品修正后重跑通过：核心 85、CLI 单测 4、CLI 集成 15；万人测试另行显式运行 |
| `cargo test --workspace --offline` | v0.1.9 发布前重跑：120 项通过（Tauri 16、CLI 单测 4、CLI 集成 15、核心 85）；万人测试默认忽略，已另行显式执行 |
| Chrome 编印端到端测试 | 4 项全部通过，48.8 秒；含键盘进入管理子菜单、模拟缺少 `URL.parse`、三类 PDF 预览导出、窄屏、并发冲突、失败重试 |
| 全量 Chrome 端到端测试 | 35 项中 30 项通过、5 项原有流程失败，见下文 |
| `cargo fmt --all -- --check`、`git diff --check` | 通过 |
| `cargo check --workspace --offline` | 通过 |
| `cargo clippy --workspace --all-targets --offline -- -D warnings` | 原有代码的 6 条 lint 阻断；未将全量检查描述为通过 |
| Android arm64 完整 Rust/Tauri `cargo check` | 通过，包含最终图片处理调整 |
| `cargo test -p branchloom --lib`（后续桌面验收） | 16 项通过 |
| Android ARM64 独立验收 APK | 构建成功；`aapt` 核对独立包名、入口与最低 Android 版本；`apksigner verify --verbose` 通过 v2 签名校验 |

新增测试覆盖：范围与直接伴侣、环与自关系、稳定编号和关系顺序、三种真实 PDF、长标题/图注及小纸张、字体缺字、附件缺失、损坏与两类加密 PDF、旋转照片、JPEG 压缩、原 PDF 页序、项目作用域、revision 冲突、字节范围读取、既有文件保护、取消与临时文件释放、schema 升级及 `.blp` 方案往返。

Chrome 的四个编印测试验证：

1. 保存方案，分别生成三类 PDF，等待真实画布渲染，翻页、下载；编辑方案后旧成品不可保存。
2. 390 × 844 窄屏保留顶部栏和菜单，设置/预览切换可用，删除方案必须确认，无文档横向溢出。
3. 两窗口修改同一方案，刷新保留本地未保存内容，旧版本保存拒绝覆盖；用户可重新载入已保存方案。
4. 模拟一次状态读取失败，任务释放后可以重新生成，不滞留在“生成中”。

全量 E2E 的 5 项失败均在此次修改范围之外：项目包页面旧文案断言、新建人物旧抽屉定位，以及托管存储明确禁用的 `mergePeople`、`cleanupProject`、`restoreSnapshot`。相关禁用分支和 UI 在仓库 HEAD 已存在；未通过削弱断言或实现无关维护功能来掩盖失败。

Clippy 的原有问题位于 `application.rs` 的 `set_local_attachment_file_if_revision` 参数数目、`mutation_arg` 显式生命周期，以及 `contract.rs` 的布尔表达式和 3 处闰年取模表达式。普通 Clippy 能完成；严格模式仍失败。此次模块出现过的一条 glyph clone lint 已修正。

发布流水线补充：v0.1.8 两次运行分别在原有 `appShell` 与 `projects` 首次进入家谱树测试中触发默认 1 秒等待超时，其余 553 项通过。两处等待改为 5 秒、单项测试上限 10 秒，保留路由和界面断言；正式发布版本更新为 v0.1.9。v0.1.8 未生成 Release。

## 万人规模

设备：Apple M2 Pro、32 GiB RAM、macOS 14.7.8、Rust release 构建。每项用独立测试进程顺序运行，通过 `/usr/bin/time -l` 记录 maximum resident set size（RSS，按 MiB 换算）。数据生成在计时之前；“耗时”包括核心排版/生成及随后重开 PDF 校验页数，不包含界面渲染、保存对话框或实际打印。

负载包含 10,000 人、9,998 条亲子关系，宽分支、深世代、多分支与孤立人物；每人有约 150 字简繁混排传记、多姓名、模糊日期及地点，另有 200 条履历、200 处引用、100 个事件。媒体组使用 100 张各不相同的 600 × 900 JPEG 合成照片、一张 PNG 封面、两页尺寸不同且第二页旋转的 PDF，按 `2,1,2` 收入附录。

| 成品 | 页数 | 耗时 | PDF 大小 | 峰值 RSS |
| --- | ---: | ---: | ---: | ---: |
| 现代谱册，文字 | 5,513 | 7.964 秒 | 19.38 MiB | 229.6 MiB |
| 现代谱册，照片与附录 | 5,638 | 8.757 秒 | 26.46 MiB | 263.5 MiB |
| 传统竖排谱册，文字 | 7,996 | 13.167 秒 | 41.26 MiB | 658.2 MiB |
| 分幅挂图 | 1,952 | 6.814 秒 | 11.00 MiB | 159.0 MiB |

以上数据已在 PDF 成品修正后重新测量。每组都验证 10,000 个不同人物 ID 完整收录、9,998 条关系保留、输出页数与重新解析的 PDF 一致。这是固定合成负载下的结果，不代表任意照片数量、任意 PDF 或所有 Android 设备都具有相同性能。传统排版的峰值内存明显更高，Android 必须补做设备测量。

复现：先执行 `cargo test -p branchloom-core --release --no-run`，运行输出中列出的测试二进制，并传入 `publication::tests::ten_thousand_people_complete_books_media_and_tiled_chart --exact --ignored --nocapture`。设置 `BRANCHLOOM_PUBLICATION_BENCHMARK` 为 `Modern-false`、`Modern-true`、`Traditional-false` 或 `Chart-false` 可单独测量；显式设置临时绝对路径 `BRANCHLOOM_PUBLICATION_SAMPLES_DIR` 可保留输出。默认普通测试跳过此压力测试，不能据此声称已做万人验收。

## PDF 结构与纸面校对

修正后的 18 人虚构媒体样张：现代 21 页、传统 25 页、分幅挂图 5 页。已用独立 PDF 解析器重开，逐一检查人物页码及内部链接目的页；现代和传统样张均保留来源 PDF 的 `2,1,2` 顺序，无目录级 JavaScript/OpenAction。正文 Noto Serif CJK 子集已嵌入并带 Unicode 映射。测试来源 PDF 使用标准 Helvetica，其原有字体资源保留，不能据此声称所有导入史料的字体均被重新嵌入。

已渲染并目视查看：封面、传统传记与中西文标点、跨幅续接、照片比例、旋转附录及姓名索引。额外逐页审查 12 人桌面导出的全部 30 页，发现的问题、修正和最终页码详见 [PDF 成品验收记录](genealogy-publication-pdf-review.md)。Poppler 提取传统正文能得到连续姓名和句子；PDF 阅读器是否采用 ActualText 影响复制/搜索体验，pypdf 的默认提取仍可能逐字换行。

## 平台范围与剩余验收

| 平台 | 已完成 | 未完成 |
| --- | --- | --- |
| macOS arm64 | 核心真实生成、文件读写、Tauri 编译与单测、Chrome 流程、纸面校对及万人测量；另以 computer-use 操作 `pnpm tauri dev` 原生窗口完成下述验收 | 实际打印装订、万人原生 UI 流程 |
| Android arm64 | 共享核心与 Tauri/文档 URI 适配编译、窄屏 Chrome 流程、PDF 临时文件转流单测、独立测试 APK 构建与签名校验；2026-09-20 用户确认 Android 真机功能与样式验收正常 | 设备型号、系统/WebView 版本和逐项记录未提供；万人设备负载尚无测量结果，[清单](genealogy-publication-android-acceptance.md)保留供复测 |
| Windows | 共用实现已接入 | 对应系统构建、预览、文件对话框和输出实测 |
| Linux | 共用实现已接入 | 对应系统构建、预览、文件对话框和输出实测 |

未执行的项目仍作为验证限制披露，不能以共享代码替代四平台实测。依用户要求在原工作目录的新分支 `codex/genealogy-publication` 开发，未使用 worktree。2026-09-20 用户确认 Android 真机验收正常，并要求将功能发布为正式版本；发布版本为 v0.1.9。用户原有 `.gitignore` 与图标修改不属于本次发布范围。

## macOS 原生窗口验收补充

以 `pnpm tauri dev` 启动，独立端口 5273，Debug 专用 `BRANCHLOOM_DATA_DIR` 指向临时目录。默认端口已占用，因此通过临时 Tauri 配置覆盖端口；为让 computer-use 识别开发进程，用临时 Cargo runner 将同一开发二进制放入 macOS `.app` 壳。所有交互通过 computer-use 在真实 Tauri/WKWebView 窗口操作；未用浏览器测试替代此项。

已实际验证：

- 项目管理入口、二级导航、选中态、顶部刷新及返回；保存方案后返回重进，设置恢复。
- 三种成品生成、真实画布预览、翻页、页码输入、50% 缩放、缩略图、挂图内页跳转。
- 三种成品均通过 macOS 原生保存对话框导出成功；取消保存后预览与保存按钮恢复可用。
- 修改设置后旧 PDF 不可保存；刷新保留未保存标题；取消离开保留输入和正确窗口标题。
- 原生截图目视检查中文标题、按钮、表单、报告和成品预览。

使用内置 12 人虚构家族（13 条关系、2 个分支），PDF 纸面审查后重新通过原生窗口导出并由 pypdf 独立重开：现代谱册 14 页 / 115290 字节，传统谱册 13 页 / 141770 字节，挂图 3 页 / 48176 字节。初始 16/22/3 页样张存在纸面问题，已被新版替换，不应使用初始文件作为验收通过证据。

本次原生验收发现并修复：WebKit 的 fieldset/grid 导致“成品样式”逐字竖排；PDF.js 标准构建依赖缺失的 `URL.parse` 导致预览报错（主线程和 worker 均改为官方兼容构建）；路由取消后窗口标题误更新。新增自动化回归覆盖后两项。

安卓交付目录为 `output/publication-acceptance/`，包含独立调试签名 APK、三种桌面导出示例、合成 JPEG、真机清单和 SHA-256。应用显示名称“有谱·编印验收”，包名 `app.branchloom.mobile.publicationtest`，与正式版数据隔离。该目录为本地生成物，不加入源码提交。
