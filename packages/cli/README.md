# @branchloom/cli

通过共享 Rust 应用核心离线访问 Branchloom 的原生命令行工具。桌面端和 CLI 使用同一个
`branchloom-core::ApplicationService`、SQLite Schema 和存储实现。

## 环境要求

- 从源码构建需要稳定版 Rust 工具链
- 通过 npm 安装需要 Node.js 20.19 或更高版本；Node.js 只负责启动原生二进制
- 默认访问桌面端资料；测试写操作需要绝对路径测试目录或隔离的命名配置

## 从本地仓库运行

以下命令均需在仓库根目录执行：

```bash
cd /Users/bytedance/work/branchloom
pnpm install
pnpm build:cli
target/debug/branchloom --help
```

如果当前目录已经是 `packages/cli`，也可以直接运行 `pnpm build:cli`；构建产物位于
`../../target/debug/branchloom`。

默认情况下，CLI 与桌面端访问同一个系统应用数据目录。macOS 下为：

```text
~/Library/Application Support/app.branchloom.desktop
```

仅在测试或明确需要隔离资料时使用 `--data-dir` 或 `--profile`。
命令行选项优先于 `BRANCHLOOM_DATA_DIR`、`BRANCHLOOM_PROFILE` 环境变量；两组配置都
要求 data-dir 与 profile 互斥。

请使用临时数据目录，不要使用真实用户数据：

```bash
BRANCHLOOM_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/branchloom-cli.XXXXXX")"
target/debug/branchloom doctor \
  --data-dir "$BRANCHLOOM_TEST_DIR" \
  --output json
```

如果希望直接使用 `branchloom` 命令，请从仓库根目录运行本地安装脚本。它会重新构建
release 二进制后再安装：

```bash
pnpm install:cli:local
branchloom --help
```

安装已经发布的版本：

```bash
npm install --global @branchloom/cli
branchloom doctor --output json
```

## 安全写入协议

所有写操作都由共享 Rust 核心先返回预览。使用返回的 `data.etag` 原样重放命令，才能
正式提交。预览是默认行为，不存在 `--preview` 参数：

```bash
branchloom person create --project <project-id> --input /absolute/person.json --output json
branchloom person create --project <project-id> --input /absolute/person.json \
  --apply --if-match <etag> --output json
```

删除等高风险写操作还需要传入预览返回的 `data.destructiveConfirmation`：

```bash
branchloom person delete --project <project-id> --id <person-id> --output json
branchloom person delete --project <project-id> --id <person-id> \
  --apply --if-match <etag> --confirm-destructive <token> --output json
```

业务数据可以通过命令选项或 `--input` 提供，但两者不能混用。`--project` 是作用域参数，
因此项目级资源必须同时使用 `--project <project-id>` 和 `--input <absolute-json-file>`。
JSON 文件不得包含 `id`、`projectId`、`revision`、`createdAt` 或 `updatedAt`；这些字段由
共享核心生成，出现时会被明确拒绝。JSON 不支持从 stdin 读取。

人物姓名是内嵌值对象，不生成 name-id；每个姓名必须包含 `value`、`type`、`primary`，
且整个人物必须恰好有一个 `primary: true`。可先读取机器契约：

```bash
branchloom person describe --output json
```

提交成功的人物等实体写入会返回 `data.changeSetId`。使用 `--output json` 时，标准输出只
包含一个 JSON envelope。

## 事件写入

事件写入 Schema 通过 `branchloom event describe --output json` 公开。复杂事件使用 JSON
文件，并通过稳定 ID 关联人物、地点和来源：

```json
{
  "type": "accession",
  "title": "赵匡胤即皇帝位",
  "date": { "precision": "exact", "start": "0960-02-04" },
  "participantIds": ["<person-id>"],
  "participantRoles": { "<person-id>": "即位者" },
  "sourceIds": [],
  "notes": ""
}
```

`participantRoles` 只能引用 `participantIds` 中的人物。所有人物、地点和来源 ID 必须存在
于同一项目。日期边界只接受 `YYYY`、`YYYY-MM` 或 `YYYY-MM-DD`，核心会校验真实日历日期、
精度所需边界和日期范围顺序。写入仍遵循相同的预览与 `etag` 提交流程。

## 关系、来源与引文写入

三类资源分别通过以下命令公开写入 Schema：

```bash
branchloom relationship describe --output json
branchloom source describe --output json
branchloom citation describe --output json
```

关系使用 `relationship add`。`category: parent` 支持 `biological`、`adoptive`、`step`、
`guardian`；`category: partner` 支持 `engaged`、`married`、`partner`、`separated`、
`divorced`。任何关系变更均为高风险写入，提交时还需要预览返回的
`destructiveConfirmation`。

来源的 `type` 支持 `book`、`archive`、`web`、`interview`、`other`。引文使用来源稳定 ID，
并通过 `targetType` 和 `targetId` 指向 `person`、`relationship`、`event` 或 `career`。
关系涉及的人物、地点和来源，以及引文的来源与目标，都必须存在于同一项目。

## 批量写入人物与关系

需要一次创建多个人物并立即建立关系时，使用原子批次。输入文件根对象包含 `actions`；
当前只支持 `person/create` 和 `relationship/add`：

```json
{
  "actions": [
    {
      "resource": "person",
      "action": "create",
      "ref": "parent",
      "payload": {
        "names": [{ "value": "李梅", "type": "personal", "primary": true }],
        "sex": "female",
        "status": "unknown"
      }
    },
    {
      "resource": "person",
      "action": "create",
      "ref": "child",
      "payload": {
        "names": [{ "value": "张三", "type": "personal", "primary": true }]
      }
    },
    {
      "resource": "relationship",
      "action": "add",
      "payload": {
        "fromPersonId": { "ref": "parent" },
        "toPersonId": { "ref": "child" },
        "category": "parent",
        "type": "biological"
      }
    }
  ]
}
```

`ref` 只在当前文件中有效，并且只能引用前面已经声明的动作。先预览：

```bash
branchloom batch run \
  --project <project-id> \
  --input /absolute/path/actions.json \
  --output json
```

预览会返回每项预分配 ID、`refMap`、完整影响范围、`etag` 和
`destructiveConfirmation`。确认后原样提交：

```bash
branchloom batch run \
  --project <project-id> \
  --input /absolute/path/actions.json \
  --apply --if-match <etag> \
  --confirm-destructive <destructiveConfirmation> \
  --output json
```

所有动作在共享 Rust 核心的一个事务中提交，只增加一次数据 revision，并形成一个
change-set。任一人物、关系或引用校验失败时，整批都不会写入。单批最多 100 项，JSON
文件最大 10 MiB；不支持 stdin、更新、覆盖或删除动作。

## 设置人物头像

头像只从本地文件导入，不接受图片 URL，也不把原始文件路径写入人物资料。`--file`
必须是绝对路径；文件会复制到 Branchloom 管理的附件目录，并按 SHA-256 内容哈希去重。

先预览：

```bash
branchloom attachment import \
  --project <project-id> \
  --person <person-id> \
  --file /absolute/path/avatar.png \
  --output json
```

确认预览后，使用原命令和返回的 `etag` 提交：

```bash
branchloom attachment import \
  --project <project-id> \
  --person <person-id> \
  --file /absolute/path/avatar.png \
  --apply --if-match <etag> \
  --output json
```

再次为同一人物导入头像会替换其头像关联；内容相同的文件不会重复保存。单个文件最大
100 MiB。

## `.blp` 项目包

`.blp` 是 GitHub 展开项目工作区的 ZIP 封装，可在不使用 GitHub 时导出、分享和导入：

```bash
branchloom project export --id <project-id> \
  --destination /absolute/family.blp --output json
branchloom project export --id <project-id> \
  --destination /absolute/family.blp \
  --apply --if-match <etag> --output json

branchloom project import --source /absolute/family.blp --output json
branchloom project import --source /absolute/family.blp \
  --apply --if-match <etag> --output json
```

相同项目 ID 已存在时，只有明确增加 `--overwrite` 才允许导入覆盖；覆盖预览还会返回
`destructiveConfirmation`，提交时必须通过 `--confirm-destructive <token>` 原样传回。

## 手动快照

手动快照会在共享 Rust 核心中以单个事务保存快照记录及可恢复的项目数据，桌面端、网页
桥接和 CLI 使用相同实现。创建仍遵循预览与 `etag` 提交流程：

```bash
branchloom project snapshot --id <project-id> --note "校对前" --output json
branchloom project snapshot --id <project-id> --note "校对前" \
  --apply --if-match <etag> --output json
```

快照名称不能为空；并发修改项目后，旧预览的 `etag` 会失效，必须重新预览。

## GitHub 同步

CLI 内置 GitHub Git Data 和 Git LFS HTTP 客户端，不依赖系统 `git` 或 `git-lfs`。
当前鉴权从进程环境读取，不会保存到项目或同步文件：

```bash
export BRANCHLOOM_GITHUB_TOKEN="<token>"
branchloom github connect --project <project-id> \
  --owner <owner> --repo <repository> --output json
branchloom github pull --project <project-id> --output json
branchloom github sync --project <project-id> --output json
```

仓库不存在时，`github connect` 的预览会显示将创建私有仓库；正式提交还必须增加
`--create`。创建完成后会立即把当前项目写入新仓库并建立同步基线。`github sync` 始终
先 Pull，再执行 `base / ours / theirs` 三方合并，最后 Push。预览有未解决冲突时不会
修改本地或远端。

冲突预览中的每一项都有稳定的 `path` 和 `field`。解决文件必须是绝对路径指定的 JSON
数组，只允许选择 `base`、`ours` 或 `theirs`：

```json
[
  {
    "path": "data/people/ab/person-id.jsonld",
    "field": "/biography",
    "choice": "theirs"
  }
]
```

把文件传给 `--resolutions /absolute/resolutions.json` 后重新预览。只有全部冲突都解决
并重新确认新的 `etag`，才允许执行同步。

## 测试

在仓库根目录运行：

```bash
pnpm test:cli
```

测试命令会测试 Rust 核心和原生 CLI，并且只使用临时测试数据库，不会读取真实用户数据。

## 许可证

`@branchloom/cli` 采用 Apache License 2.0，详见随 npm 包分发的 `LICENSE` 文件。
