<p align="center">
  <img src="packages/desktop/src-tauri/icons/128x128.png" width="96" alt="有谱应用图标">
</p>

<h1 align="center">有谱 · Branchloom</h1>

<p align="center">
  <strong>把散落的名字、照片与往事，整理成一份可以长久保存的家族档案。</strong>
</p>

<p align="center">
  本地优先 · 无需注册 · 开放格式 · 家人异步协作 · 支持 macOS / Windows / Linux / Android
</p>

<p align="center">
  <a href="https://github.com/tenlee2012/branchloom/releases">下载桌面版 / Android 版</a>
  ·
  <a href="https://pan.quark.cn/s/2ec290e5499c">夸克网盘</a>
  ·
  <a href="https://www.alipan.com/s/yVxJsJhSE2L">阿里云盘</a>
  ·
  <a href="DATA_FORMAT.md">开放数据格式 `.blp`</a>
  ·
  <a href="packages/cli/README.md">CLI 文档</a>
</p>

![有谱桌面版家谱树](docs/screenshots/family-tree.jpg)

> 截图使用虚构的演示家族、仓库与安装路径；真实家谱默认只保存在用户自己的设备上。

## 家谱不只是一张关系图

有谱是一款本地优先的家谱与家庭资料管理应用。它把人物、关系、事件、地点、史料来源和附件放在同一个项目中，让一段家族历史既能被直观浏览，也能保留可以追溯的依据。

| | |
| --- | --- |
| **资料真正属于你**<br>无需账号，离线可用；可以完整备份、迁移，或通过自己的 GitHub 私有仓库与家人协作。 | **尊重真实的家庭经历**<br>支持亲生、收养、继亲、监护和多种伴侣关系，不用单一模板简化复杂人生。 |
| **每条记忆都有来处**<br>把档案、访谈、引文、页码和本地附件关联到人物、关系与事件。 | **为长期保存而设计**<br>通过 `.blp` 完整项目包、GEDCOM 和开放格式，避免资料被锁在某个网站里。 |

## 从关系到故事

<table>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/person-profile.jpg" alt="人物档案界面">
      <br><strong>人物档案</strong><br>
      记录多种姓名、生卒信息、地点、生平、职业经历、备注、头像与相关资料。
    </td>
    <td width="50%">
      <img src="docs/screenshots/family-timeline.jpg" alt="家族时间线界面">
      <br><strong>家族时间线</strong><br>
      把出生、婚姻、迁徙与家庭事件放回时间中，沿年代阅读家族故事。
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <img src="docs/screenshots/sources-and-citations.jpg" alt="史料来源、引用与附件界面">
      <br><strong>来源、引用与附件</strong><br>
      从一页族谱、一段访谈或一张旧照片出发，看见它支持了哪些人物、关系和事件。
    </td>
  </tr>
</table>

## 亮点：通过 GitHub 与家人共同维护家谱

有谱把 GitHub 私有仓库变成可审阅、可回溯的家庭协作空间。获得仓库权限的家人可以在各自设备上离线整理同一个项目，需要交换资料时再进行同步；不要求注册有谱账号，也不依赖有谱运营的云端服务。

![有谱桌面版 GitHub 同步页面](docs/screenshots/github-sync.jpg)

- **资料可读、历史可查**：仓库保存展开后的 JSON-LD 项目文件和附件，而不是难以审阅的 SQLite 数据库；可以直接查看变更并利用 Git 历史回溯。
- **先预览，再同步**：Pull、完整同步和冲突处理都会先展示预览；每次 Push 前始终先 Pull 并执行字段级三方合并，存在未解决冲突时不会上传。
- **适合多人异步维护**：不同人物、事件或字段上的修改可以自动合并；同一字段发生冲突时，由用户选择共同基线、本地版本或 GitHub 版本。
- **加入项目很直接**：可以从首页导入家人已有的 Branchloom 仓库；当前项目仍为空白时，也可以先检查远端内容，再用 GitHub 项目直接覆盖。
- **凭据与家谱分离**：每位协作者使用自己的 GitHub 身份和 token；桌面端将 token 保存在系统安全凭据存储中，Android 端仅在本次运行期间保留，重启应用后需重新输入。token 不会进入 SQLite、项目文件、`.blp` 包或同步基线。
- **手动与定时同步兼顾**：各平台均可手动同步；桌面端还支持在应用运行期间每 60 分钟自动检查，应用退出后自动停止。Android 端目前仅支持手动同步。

> GitHub 同步完全可选，适合备份和多人异步协作，不是实时共同编辑。GitHub 私有仓库也不是端到端加密存储，请只邀请可信成员，并谨慎同步仍在世成员的资料。

## AI 辅助：让整理更高效，也更可控

有谱桌面端直接提供版本匹配的原生 CLI 和 Codex Skill。AI Agent 可以理解家谱结构、查找资料、生成修改计划，并在得到确认后完成批量整理；整个过程复用桌面端相同的核心规则和数据目录，不需要为 AI 再维护一套数据库逻辑。

Android 端目前不提供 CLI、Codex Skill 安装或“AI 工具”页面。

![有谱桌面版 AI 工具页面](docs/screenshots/ai-tools.jpg)

- CLI 与 Skill 随桌面安装包离线提供，不依赖 npm、npx、Node.js 或常驻后台服务。
- “AI 工具”页面统一检查桌面版本、CLI 合约、目标平台和组件完整性，并支持安装、更新、修复与卸载。
- 写操作默认先生成预览；真正提交时必须携带同一计划的版本标识，资料发生变化后旧计划会失效。
- 删除、关系变更等高风险操作还需要额外的危险操作确认，不允许 AI 静默绕过。
- 每次成功写入都会返回可追踪的变更集，便于核对后续影响。

## 主要能力

### 整理家族资料

- 创建和管理多个家谱项目。
- 记录人物的多种姓名、生卒信息、生平、职业、称谓、备注和头像。
- 整理亲生、收养、继亲、监护，以及婚姻、订婚、事实伴侣、分居、离异等关系。
- 从家谱树、人物列表和时间线浏览家庭资料。
- 桌面家谱树支持部分姓名、字号搜索，高亮匹配人物并点击定位；选中人物后，在卡片和“人物与称呼”列表查看其对其他人物的日常称呼，如爸爸、妈妈、爷爷、奶奶、太奶奶。长幼不明时保留“兄弟”“姐妹”等合称；上四代及更远的直系祖辈显示“老祖宗”及代数。称呼仅根据已载入资料的最短关系路径计算，收养、继亲、监护、已结束的伴侣关系及信息不足的情况保留关系说明，不写入家谱资料。
- 管理地点、家庭事件、史料来源、引文与本地附件。

### 核对、备份与迁移

- 搜索人物，并检查日期异常、关系问题、重复人物和缺失附件。
- 比较并合并疑似重复档案。
- 创建可恢复的历史快照。
- 导入或导出包含附件的 `.blp` 完整项目包。
- 导入或导出 GEDCOM 5.5、5.5.1 与 7.0 中常见的人物及家庭关系资料。
- 可选连接自己的 GitHub 私有仓库，通过 Git 版本历史备份、同步与回切项目，并邀请可信家人在各自设备上异步协作。

## 数据与隐私

- 家谱资料默认只保存在本机，不注册账号也能完整使用。
- GitHub 同步完全可选；访问凭据不会写入家谱项目或导出的项目包。
- GitHub 私有仓库不是端到端加密存储；拥有仓库权限的协作者可以读取项目文件及 Git 历史，请只邀请可信成员，并谨慎同步仍在世成员的资料。
- 附件会被复制到项目管理区域，并按内容哈希去重；业务记录不保存原始文件路径。
- `.blp` 项目包包含完整资料和附件，可用于备份、迁移与分享。
- 项目格式公开可读，详细约定见 [DATA_FORMAT.md](DATA_FORMAT.md)。

家谱常常包含仍在世成员的敏感信息。分享项目包、截图或同步仓库前，请先征得相关家庭成员同意，并确认分享范围。重要资料建议保留至少一份独立备份，并在升级前导出 `.blp` 项目包。

## 获取有谱

前往 [GitHub Releases](https://github.com/tenlee2012/branchloom/releases) 下载与操作系统匹配的安装包。macOS 用户请根据设备选择 `Apple-Silicon`（M1 及后续 Apple 芯片）或 `Intel` 版本。

也可通过网盘下载，两个入口均永久有效、无需提取码：

- [夸克网盘](https://pan.quark.cn/s/2ec290e5499c)
- [阿里云盘](https://www.alipan.com/s/yVxJsJhSE2L)：公开分享页目前仅显示 Windows / Linux 安装包；macOS 请使用夸克网盘或 GitHub Releases。

网盘安装包来自本项目 GitHub Releases，按「有谱 / v版本号」归档，目前收录 v0.1.0～v0.1.4。这些版本沿用旧文件名，macOS 的 `aarch64` 对应 Apple 芯片，`x64` 对应 Intel 芯片。

安装包文件名会直接标明系统、处理器和版本；桌面端额外标注 `Desktop`，Android APK 以 `_release.apk` 结尾：

| 文件名示例 | 适用设备 |
| --- | --- |
| `Branchloom_Desktop_Windows_x64_v0.1.5-setup.exe` | Windows 桌面电脑 |
| `Branchloom_Desktop_macOS_Apple-Silicon_v0.1.5.dmg` | Apple 芯片 Mac（M1 及后续型号） |
| `Branchloom_Desktop_macOS_Intel_v0.1.5.dmg` | Intel 芯片 Mac |
| `Branchloom_Desktop_Linux_x64_v0.1.5.AppImage` / `.deb` | 64 位 Linux 桌面电脑 |
| `Branchloom_Android_arm64_v0.1.5_release.apk` | Android 12 及以上的 ARM64 设备；已签名的 Release APK |
| `Branchloom_iOS_arm64_v0.1.5.ipa` | iPhone；iOS 安装包尚未提供，此名称为后续发布预留 |

<details>
<summary><strong>Android 安装提示</strong></summary>

从 GitHub Releases 下载 `Branchloom_Android_arm64_v<版本>_release.apk`，在 Android 设备上打开并按系统提示允许本次安装。当前支持 Android 12 及以上的 ARM64 设备。

</details>

<details>
<summary><strong>macOS 首次安装提示</strong></summary>

目前 macOS 安装包使用 ad-hoc 签名，尚未使用 Apple Developer ID 签名和公证。请只从本项目官方 Releases 或上方网盘入口下载并确认来源可信。

将“有谱”拖入“应用程序”文件夹后，如果系统提示“App 已损坏”或无法验证开发者，请打开“终端”执行：

```bash
xattr -dr com.apple.quarantine "/Applications/有谱.app"
open "/Applications/有谱.app"
```

该命令只移除“有谱”的互联网下载隔离标记，不会关闭系统的全局 Gatekeeper。仅对从本项目官方 Releases 或上方网盘入口下载的安装包执行此操作。

</details>

<details>
<summary><strong>Windows 安装提示</strong></summary>

Windows 安装包目前未进行商业代码签名，安装时操作系统可能显示安全提醒。请确认安装包来自本项目官方 Releases 或上方网盘入口后再继续。

</details>

## 安装 CLI 与 Codex Skill

打开桌面端的“AI 工具”页面，即可安装、更新、修复或卸载与当前桌面版本匹配的 Branchloom CLI 和 Codex Skill。

- macOS / Linux 默认安装到 `~/.local/bin`。
- Windows 默认安装到 `%LOCALAPPDATA%\Branchloom\bin`。
- Skill 默认安装到 `~/.agents/skills/branchloom`。
- 如果目录尚未加入 `PATH`，桌面端会显示可复制的配置方法，但不会自动修改 Shell 或系统设置。

机器协议、隔离数据目录和命令示例见 [CLI 文档](packages/cli/README.md)。

## 本地开发

需要 Node.js、pnpm 10.15.1 和 Rust 工具链。安装依赖后可启动 Web 开发模式：

```bash
pnpm install
pnpm dev
```

常用检查：

```bash
pnpm typecheck
pnpm test:unit
pnpm test:cli
```

发布版本只维护根 `Cargo.toml` 中的一处 workspace 版本。使用命令更新版本并自动刷新 `Cargo.lock`：

```bash
pnpm release:version 0.1.6
```

发布 tag 必须与 workspace 版本一致，例如版本 `0.1.6` 对应 `v0.1.6`。

版本发布说明保存在 `.github/release-notes/<tag>.md`（如 `.github/release-notes/v0.1.6.md`）。发布流水线创建或更新 Release 时优先使用对应说明；缺少该文件时使用默认安装说明。

Android 构建（`pnpm build:android`、`pnpm build:android:release`）以及通过 `pnpm tauri android` 调用的初始化、开发和构建命令，会自动读取同一 workspace 版本并传给 Tauri。APK 的 `versionName` 与该版本一致，`versionCode` 按 [Tauri 默认规则](https://v2.tauri.app/reference/config/#versioncode) `major × 1000000 + minor × 1000 + patch` 生成，例如 `0.1.5` 对应 `1005`。无需在 `tauri.conf.json` 或生成的 `gen/android` 中另行维护版本号。

本地生成可安装的 Android Release APK，先复制 `.env.android.example` 为 `.env.android.local`，填入签名密钥的绝对路径 `ANDROID_KEYSTORE_PATH` 和别名 `ANDROID_KEY_ALIAS`，再运行：

```bash
pnpm build:android:release
```

命令会完成构建、对齐、签名和校验，产物为 `packages/desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`。已有未签名 APK 时，可直接运行 `pnpm android:sign`，无需重新构建。密码在终端中输入；非交互环境可通过 `ANDROID_KEYSTORE_PASSWORD` 和 `ANDROID_KEY_PASSWORD` 环境变量提供。`.env.android.local` 和密钥文件已被 Git 忽略；后续版本应继续使用同一签名密钥。

Debug 使用 Android 工具链自动生成并复用的调试密钥，不读取 `.env.android.local`，也不需要正式签名密码。命令与产物如下：

| 命令 | 签名 | APK 文件名 |
| --- | --- | --- |
| `pnpm build:android:debug`（或 `pnpm build:android`） | 默认调试签名 | `universal/debug/app-universal-debug.apk` |
| `pnpm build:android:release` | `.env.android.local` 配置的正式签名 | `universal/release/app-universal-release.apk` |

产物目录均位于 `packages/desktop/src-tauri/gen/android/app/build/outputs/apk/`。调试签名不是每次构建随机更换的临时密钥；Debug 与 Release 的签名不同，同包名时不能互相覆盖安装。

`pnpm build:android:release:unsigned` 只生成未签名 APK，供 CI 的独立签名步骤使用，不能直接安装。

Android 原生入口与全局浅色主题维护在 `packages/desktop/src-tauri/android/`；初始化、开发和构建命令会自动同步到 `gen/android`。状态栏的时间、通知图标与底部系统导航图标统一使用深色，切换系统深色模式或重新生成 Android 项目后仍与应用的浅色背景保持一致。

## 参与项目

欢迎通过 Issue、Discussion 或 Pull Request 参与有谱：报告问题、提出真实的家谱整理场景、改进无障碍体验与文案，或协助测试数据导入、备份和跨平台体验。

提交问题时，请使用虚构或脱敏的示例，不要上传真实家谱、私人附件、访问凭据或其他敏感信息。

## 项目原则

1. 本地资料优先于在线服务。
2. 用户可以完整导出并迁移自己的数据。
3. 不以“常见”为由拒绝真实存在的家庭关系。
4. 重要事实应当能够关联来源。
5. 破坏性操作必须清楚、可预期。

## 开源许可

本项目采用 [Apache License 2.0](LICENSE) 开源。第三方组件分别遵循其各自的许可证，详见 [第三方软件声明](THIRD_PARTY_NOTICES.md)。
