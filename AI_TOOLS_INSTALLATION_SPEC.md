# Branchloom 桌面端 CLI 与 Skill 安装规格

状态：需求已确认并已授权实施

目标平台：macOS Apple Silicon、macOS Intel、Windows x64、Linux x64

CLI contract version：3

## 1. 目标与用户场景

Branchloom 桌面端作为 Branchloom CLI 和 Branchloom Skill 的唯一安装、升级、修复与卸载入口。CLI 二进制和 Skill 随桌面安装包离线分发，用户安装和使用时不依赖 npm、npx、Node.js、后台常驻服务或桌面端持续运行。

用户可以在桌面端：

- 一键安装相互兼容的 CLI 和 Skill。
- 查看安装状态、安装路径、版本和 contract 兼容性。
- 在桌面端升级、修复或卸载受 Branchloom 管理的 CLI/Skill。
- 安装后从终端直接运行 `branchloom`，并让 Codex 发现和调用 Branchloom Skill。
- 桌面端升级后，手动确认更新随新桌面版本携带的 CLI 和 Skill。

安装是当前用户和当前设备范围的能力，不属于任何家谱项目。

## 2. 已确认决策

### 2.1 Agent 支持

- 当前目标仅支持 Codex 的全局 Skill 安装。
- 安装实现应使用 Agent 安装适配器封装目标位置和发现规则，为其他 Agent 预留扩展点。
- 不提供任意目录安装，避免目标路径和发现行为不可控。

### 2.2 CLI 与 PATH

- macOS/Linux 的公开命令目标为 `~/.local/bin/branchloom`。
- Windows 的公开命令目标为 `%LOCALAPPDATA%\Branchloom\bin\branchloom.exe`。
- macOS/Linux 检测 `~/.local/bin` 是否在当前用户 PATH 中。
- Windows 检测 `%LOCALAPPDATA%\Branchloom\bin` 是否在当前用户 PATH 中。
- PATH 缺失时显示可复制的 Shell 配置和重新打开终端提示。
- 不自动修改 `.zshrc`、`.bashrc`、PowerShell profile、系统 PATH 或其他 Shell 配置。

### 2.3 平台范围

- macOS Apple Silicon（`aarch64-apple-darwin`）。
- macOS Intel（`x86_64-apple-darwin`）。
- Windows x64（`x86_64-pc-windows-msvc`）。
- Linux x64（`x86_64-unknown-linux-gnu`）。
- 上述平台均属于同一交付目标，不采用分平台、分阶段补齐的交付策略。
- 任一平台的 CLI 构建、资源打包、安装、诊断、升级、修复、卸载和自动化验证未完成时，不得把该平台发布为具备本功能的正式安装包。

### 2.4 更新策略

- CLI 和 Skill 不提供独立联网更新。
- 新版本由桌面安装包携带。
- 桌面端检测到已安装版本较旧时显示更新提示，但不静默更新。
- 用户明确点击“更新全部”后才替换文件。
- 默认同时安装或更新 CLI 与 Skill；允许分别进行修复和卸载。

## 3. 功能范围

### 3.1 全局“AI 工具”页面

新增独立全局页面，建议路由为 `/ai-tools`：

- 首页提供“AI 工具”入口。
- 项目侧边栏底部提供同一入口。
- 页面不依赖当前项目，也不需要先成功打开本地家谱。
- Web 开发模式只显示“仅桌面版支持”，不得模拟安装或写入浏览器存储。

页面包含 CLI 和 Skill 两张状态卡，以及默认的“安装 CLI 和 Skill”主操作。

CLI 状态至少包括：

- 未安装。
- 已安装且兼容。
- 有更新。
- 文件损坏。
- 目标位置被其他文件占用。
- 已安装但终端 PATH 不可见。

Skill 状态至少包括：

- 未安装。
- 已安装且与 CLI 兼容。
- 有更新。
- 已被用户修改。
- 目标位置存在非 Branchloom 管理内容。
- CLI 缺失或 contract 不兼容。

### 3.2 操作

- 预览安装 CLI 与 Skill。
- 确认并安装。
- 更新全部。
- 分别修复 CLI 或 Skill。
- 分别卸载 CLI 或 Skill。
- 运行 CLI 版本及兼容性诊断。
- 查看安装位置。
- PATH 不可见时复制配置说明。

## 4. 非目标

- 不通过 npm 发布、安装或升级 Branchloom CLI。
- 不使用 `npx skills add` 安装或升级 Branchloom Skill。
- 不要求用户安装 Node.js、npm、pnpm 或 npx。
- 不提供系统级或管理员权限安装。
- 不提供后台常驻服务。
- 不提供 CLI/Skill 独立在线更新器。
- 不管理第三方 Skill。
- 不自动修改 Shell 配置。
- 当前目标不支持 Codex 之外的 Agent。
- 不在桌面 App 卸载时自动删除已经复制到用户目录的 CLI/Skill。
- 不改变现有 CLI contract version 3 和业务写入确认协议。

pnpm 和 Node.js 仍可用于仓库开发、Vue 前端构建和 CI；它们不属于 CLI/Skill 的用户安装链路。

## 5. 安装包与版本设计

每个受支持的桌面安装包必须携带与当前桌面版本同源构建的原生 CLI、Skill 和安装清单。建议安装包资源布局为：

```text
resources/ai-tools/
├── manifest.json
├── cli/
│   └── branchloom-cli
└── skills/
    └── branchloom/
        ├── SKILL.md
        ├── references/
        └── evals/
```

安装清单至少包含：

```json
{
  "desktopVersion": "0.1.1",
  "cliVersion": "0.1.1",
  "contractVersion": 3,
  "platform": "darwin-arm64",
  "cliSha256": "...",
  "skillSha256": "..."
}
```

约束：

- CLI 必须从与桌面端相同的仓库 revision 和 release tag 构建。
- 当前桌面端和 CLI 的 Rust 产物名称都可能是 `branchloom`。内部 CLI 构建产物改为 `branchloom-cli`，安装后的公开命令仍为 `branchloom`，避免打包和 Cargo target 冲突。
- Skill 版本与 CLI contract version 必须显式写入安装清单，不能只通过文件时间推断。
- 桌面端只使用安装包内资源，不从网络下载可执行文件或 Skill。

## 6. 原生接口与安装流程

安装能力属于桌面平台集成，不属于家谱业务数据。实现放在 Tauri 原生层的独立安装服务中，不进入 `branchloom-core::ApplicationService`，也不通过 `BranchloomRepository` 访问。

建议的原生接口：

```text
get_ai_tools_status
preview_ai_tools_change
apply_ai_tools_change
```

流程：

1. 前端读取状态，不产生文件写入。
2. 用户选择安装、更新、修复或卸载。
3. 原生端生成预览，返回确切组件、目标位置、覆盖行为、冲突和 PATH 状态。
4. 用户明确确认。
5. 前端提交预览返回的短期 `planId`。
6. 原生端重新校验目标状态，避免预览后文件被改变。
7. 原生端在目标文件系统内写入临时文件，校验后原子替换。
8. 安装完成后从确定的绝对路径运行版本与 `doctor` 检查。
9. 任一组件失败时恢复原工作版本，不留下 CLI/Skill 半更新状态。

前端不得传入资源来源、任意可执行文件路径或未经适配器验证的 Skill 目标目录。

安装完成后的诊断示例：

```bash
branchloom version --output json
branchloom doctor --output json
```

## 7. 冲突、修复与卸载

- Branchloom 管理的旧版本可以升级或修复。
- 非 Branchloom 管理的同名 CLI 或 Skill 目录不得静默覆盖。
- Skill 内容与安装清单哈希不一致时标记为“已修改”，更新和卸载前必须明确提示。
- 安装记录必须足以证明文件由 Branchloom 创建；卸载只删除受管理文件。
- 删除后若目录中仍有未知文件，保留目录和未知文件。
- 卸载 CLI 或 Skill 不得删除数据库、附件、GitHub 凭据、同步资料或其他用户数据。

## 8. 数据与安全策略

- 安装服务不读取或修改任何家谱项目数据。
- 不使用 `sh -c`、字符串拼接 Shell 命令或 PATH 搜索执行待验证程序。
- 所有来源和目标路径由原生端确定并进行规范化，拒绝符号链接穿越和越界目标。
- 安装前后校验资源 SHA-256。
- Unix CLI 权限设置为可执行，Skill 文件保持普通用户可读写权限。
- 安装日志不记录家谱数据、访问令牌或其他敏感内容。
- Skill 调用 CLI 后，写操作继续遵守预览、`--apply`、`--if-match`、etag 和危险操作确认机制。
- 当前发布未使用 Apple Developer ID 签名和公证；macOS 两种架构的构建都应至少完成 CLI 的 ad-hoc 签名和校验，不得通过代码自动移除系统隔离标记。

## 9. GitHub Actions 发布流程变更

实现本功能时必须同步修改 `.github/workflows/release.yml`。发布矩阵中的每个平台都必须构建并携带自己的 CLI 和相同版本的 Skill：

1. 校验 release tag、根版本、桌面版本、Tauri 版本和 Rust CLI 版本一致。
2. 不再以 `packages/cli/package.json` 作为 CLI 发布版本或 npm 包版本的权威来源。
3. 为 `aarch64-apple-darwin`、`x86_64-apple-darwin`、`x86_64-pc-windows-msvc` 和 `x86_64-unknown-linux-gnu` 分别构建 release CLI。
4. macOS 两个产物进行 ad-hoc 签名并验证签名；Windows 和 Linux 产物执行对应格式、架构和可执行性校验。
5. 每个 matrix job 将本平台 CLI 和 `skills/branchloom` 复制到独立的临时 Tauri resources staging 目录；生成物不得提交到 Git。
6. 每个平台分别计算 CLI 与 Skill 的确定性 SHA-256，并生成含正确 target triple 的 `manifest.json`。
7. 验证 manifest 的平台、版本、contract version、文件哈希和 CLI 诊断结果。
8. 再执行对应平台的 Tauri 桌面安装包构建，确保 installer 包含完整 AI tools resources。
9. 对生成的 `.app`、`.dmg`、`.exe`、`.deb` 和 `.AppImage` 做资源存在性检查后才上传 GitHub Release。
10. 只有四个平台的构建和资源校验全部成功，release 才能进入可发布状态；不得上传缺少 CLI 或 Skill 的降级安装包。
11. 发布说明明确说明安装包内含对应平台 CLI 与 Codex Skill，并说明通过桌面端安装。

workflow 不增加 npm publish、npm pack 或 `npx skills add` 步骤。Node.js 与 pnpm 只用于前端构建和测试。

## 10. 验收标准

- 在没有 Node.js、npm、pnpm、npx 的全新 macOS Apple Silicon、macOS Intel、Windows x64 和 Linux x64 用户环境中，都可通过桌面端离线安装 CLI 和 Skill。
- 安装后重新打开终端，可以运行 `branchloom doctor --output json`。
- `doctor` 返回 CLI contract version 3 且与 Skill 兼容。
- Codex 重新加载 Skill 后可以发现 Branchloom Skill。
- 桌面端升级后能识别旧版本，并在用户确认后同时更新 CLI 与 Skill。
- PATH 缺失时不会假装命令可用，页面提供正确的可复制配置。
- 现有非 Branchloom 文件不会被覆盖或删除。
- 安装失败或进程中断后，原版本仍可工作，或保持完全未安装状态。
- 卸载 CLI/Skill 后，家谱数据库和附件完全不受影响。
- GitHub Release 中四个目标平台的每个安装包都包含经过清单校验且架构匹配的 CLI 和 Skill。
- 自动化测试只使用临时用户目录和测试资源，不读取或写入真实用户数据。

## 11. 实施授权状态

用户已明确授权实施。桌面端、CLI、Skill、打包配置和 GitHub Actions workflow 应以本文档作为本功能的验收依据。
