# Branchloom 数据格式

Branchloom 使用一种基于 JSON-LD 1.1 的开放文本格式保存族谱项目。本文件既是格式说明，
也是实现者需要遵守的数据约定。

> - 状态：v1 核心格式已实现；字段级 context 与 Schema 约束仍在完善
> - 格式名称：Branchloom JSON-LD Repository Format
> - 格式版本：`1.0.0`
> - 最后更新：2026-07-28

如果你只是想了解自己的数据如何保存，请先阅读“快速理解”和“一个最小例子”。如果你
准备实现导入器、导出器或同步客户端，请继续阅读后面的完整规则。

## 快速理解

一个 Branchloom 项目对应一个 Git 仓库：

```text
一个人物       = 一个 .jsonld 文件
一条亲属关系   = 一个 .jsonld 文件
一个事件       = 一个 .jsonld 文件
图片和 PDF     = Git LFS 文件
修改历史       = Git commit
本地查询       = SQLite
```

整体关系如下：

```text
GitHub 私有仓库
  ↕ Git fetch / merge / push
本地 JSON-LD 工作树
  ↕ 校验、导入、导出
本地 SQLite
  ↕
Branchloom 桌面应用
```

几个重要结论：

- JSON-LD 是可以被普通 JSON 解析器读取的 JSON，不需要专用数据库才能查看。
- SQLite 用于本地快速查询和事务；JSON-LD 用于开放存储、Git 版本管理和同步。
- GitHub 是可选远端。断网、没有 GitHub 账号时，本地项目仍然可以使用。
- 图片会存入 GitHub，但通过 Git LFS 保存，不直接塞进 JSON。
- GEDCOM 仍用于与其他族谱软件交换，不是 Branchloom 的内部主格式。
- 开源的是 Branchloom 软件和格式，不代表用户的族谱数据必须公开。族谱仓库默认应为
  私有仓库。

## 一个最小例子

假设项目中有张三和他的女儿张小雨，仓库中至少有：

```text
branchloom.jsonld
project.jsonld
context/branchloom-v1.jsonld
data/people/01/018f96b5-ae11-73dc-a51c-412fa8f60c65.jsonld
data/people/01/018f96ed-0195-73a9-ad45-f8feb5f16e78.jsonld
data/relationships/01/018f9737-c70b-7801-9b60-edced81609de.jsonld
```

张三的人物文件：

```json
{
  "@context": "https://branchloom.app/context/v1",
  "@id": "urn:uuid:018f96b5-ae11-73dc-a51c-412fa8f60c65",
  "@type": "Person",
  "project": "urn:uuid:018f96ab-2f41-7d31-91f8-11a04ce81b21",
  "revision": 3,
  "names": [
    {
      "value": "张三",
      "nameType": "personal",
      "primary": true,
      "notes": "",
      "sources": []
    }
  ],
  "sex": "male",
  "status": "living",
  "biography": "",
  "notes": "",
  "sources": [],
  "createdAt": "2026-07-01T08:00:00.000Z",
  "updatedAt": "2026-07-26T09:30:00.000Z"
}
```

父女关系单独保存：

```json
{
  "@context": "https://branchloom.app/context/v1",
  "@id": "urn:uuid:018f9737-c70b-7801-9b60-edced81609de",
  "@type": "Relationship",
  "project": "urn:uuid:018f96ab-2f41-7d31-91f8-11a04ce81b21",
  "revision": 1,
  "category": "parent",
  "relationType": "biological",
  "fromPerson": "urn:uuid:018f96b5-ae11-73dc-a51c-412fa8f60c65",
  "toPerson": "urn:uuid:018f96ed-0195-73a9-ad45-f8feb5f16e78",
  "notes": "",
  "sources": [],
  "createdAt": "2026-07-26T09:30:00.000Z",
  "updatedAt": "2026-07-26T09:30:00.000Z"
}
```

这里：

- `@id` 是记录永不随姓名变化的身份。
- `@type` 说明这是什么数据。
- `@context` 说明每个字段的公开语义。
- `fromPerson` 和 `toPerson` 通过 `@id` 引用人物。
- `revision` 记录实体修改次数，但不能代替 Git 的三方合并。

## 为什么选择 JSON-LD

JSON-LD 是 JSON 的语义化扩展。普通 JSON 只说明“这里有一个叫 `fromPerson` 的字段”，
JSON-LD context 还能说明这个字段代表什么、它引用的是什么类型的对象。

这对族谱数据很重要，因为族谱不是一张固定的树，而是一张图：

- 人物是节点。
- 亲子、伴侣、任职、引用是边。
- 关系本身还可以有时间、地点、来源和备注。
- 同一个人物可以拥有名、字、号、谱名、谥号等多个身份名称。

JSON-LD 的优势：

- 仍然是易读、易处理的 JSON。
- 使用稳定 URI 表达跨文件引用。
- 可以映射到 Schema.org、RDF 或未来的知识图谱。
- Branchloom 扩展字段不会被迫塞进 GEDCOM 私有标签。
- 可以用 JSON Schema 校验文件结构。

JSON-LD 本身不会自动解决 Git 冲突。Branchloom 仍然需要实体分文件和业务三方合并规则。

## 设计目标

格式必须做到：

1. 无损保存 Branchloom 支持的全部项目数据。
2. 普通文本工具可以查看，第三方程序可以解析。
3. 同一逻辑状态每次导出产生相同内容。
4. 修改一个人物时尽量只改变一个文件。
5. 能从零开始确定性重建 SQLite。
6. 支持图片、PDF、音视频和史料附件。
7. 支持离线编辑、Git 历史和多设备三方合并。
8. 删除数据后不会因为另一设备同步旧版本而静默复活。
9. 不支持新格式的旧客户端不能静默破坏数据。

v1 不负责定义：

- GitHub OAuth 的具体交互界面。
- 仓库成员和多人权限模型。
- 端到端加密协议。
- GitHub 以外托管平台的账号接入。
- GEDCOM 的完整字段映射表。

## 仓库结构

一个项目仓库使用以下结构：

```text
branchloom.jsonld
project.jsonld

context/
  branchloom-v1.jsonld

data/
  people/ab/<uuid>.jsonld
  relationships/ab/<uuid>.jsonld
  events/ab/<uuid>.jsonld
  places/ab/<uuid>.jsonld
  organizations/ab/<uuid>.jsonld
  careers/ab/<uuid>.jsonld
  person-titles/ab/<uuid>.jsonld
  sources/ab/<uuid>.jsonld
  citations/ab/<uuid>.jsonld
  attachments/ab/<uuid>.jsonld
  attachment-links/ab/<uuid>.jsonld
  manual-issues/ab/<uuid>.jsonld

media/
  sha256/ab/<sha256>

.gitattributes
.gitignore
```

`ab` 是 UUID 或哈希去掉分隔符后的前两个字符。分片可以避免大型族谱把数万个文件放在
同一个目录中。

路径必须由稳定 ID 生成，不能由姓名或标题生成。人物改名不应该导致 Git 文件重命名。

## Git 和 Git LFS

仓库必须包含：

```gitattributes
*.jsonld text eol=lf
media/** filter=lfs diff=lfs merge=lfs -text
```

- `.jsonld` 是普通 Git 文本文件。
- `media/**` 是 Git LFS 文件。
- 应从创建仓库时启用 LFS。
- 正式客户端不能假定用户已经安装 `git-lfs`，需要自己集成或明确提供 LFS 能力。
- 同步程序不得自动 force push。
- 恢复历史版本必须创建新提交，不能重写已经共享的历史。

## 根清单

`branchloom.jsonld` 是打开仓库时读取的第一个文件：

```json
{
  "@context": "https://branchloom.app/context/v1",
  "@id": "urn:uuid:018f9690-0a12-7e11-8b94-39c71d9c15ef",
  "@type": "Repository",
  "format": "branchloom-json-ld",
  "formatVersion": "1.0.0",
  "project": "urn:uuid:018f96ab-2f41-7d31-91f8-11a04ce81b21",
  "projectFile": "project.jsonld",
  "contextDocument": {
    "uri": "https://branchloom.app/context/v1",
    "localPath": "context/branchloom-v1.jsonld",
    "contentHash": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  },
  "requiredFeatures": [
    "core",
    "organizations",
    "careers",
    "person-titles",
    "git-lfs-media"
  ]
}
```

示例中的全零哈希只是占位。真实仓库必须保存 context 文件的真实 SHA-256。

| 字段 | 含义 |
|---|---|
| `format` | 固定为 `branchloom-json-ld` |
| `formatVersion` | 数据格式版本 |
| `project` | 当前项目的 URI |
| `projectFile` | 项目元数据文件 |
| `contextDocument` | context 的公开 URI、本地副本和内容哈希 |
| `requiredFeatures` | 客户端必须理解的功能集合 |

根清单的 `@id` 是仓库身份，必须与项目 `@id` 不同。

## Context：字段词典

`context/branchloom-v1.jsonld` 是所有字段的词典。以下是缩减示例：

```json
{
  "@context": {
    "@version": 1.1,
    "@protected": true,
    "bl": "https://branchloom.app/vocab/v1#",
    "schema": "https://schema.org/",
    "xsd": "http://www.w3.org/2001/XMLSchema#",

    "Repository": "bl:Repository",
    "Project": "bl:Project",
    "Person": "schema:Person",
    "Relationship": "bl:Relationship",
    "FamilyEvent": "bl:FamilyEvent",
    "Place": "schema:Place",
    "Organization": "schema:Organization",
    "Attachment": "schema:MediaObject",

    "project": {
      "@id": "bl:project",
      "@type": "@id"
    },
    "fromPerson": {
      "@id": "bl:fromPerson",
      "@type": "@id"
    },
    "toPerson": {
      "@id": "bl:toPerson",
      "@type": "@id"
    },
    "sources": {
      "@id": "bl:source",
      "@type": "@id",
      "@container": "@set"
    },
    "createdAt": {
      "@id": "schema:dateCreated",
      "@type": "xsd:dateTime"
    },
    "updatedAt": {
      "@id": "schema:dateModified",
      "@type": "xsd:dateTime"
    }
  }
}
```

正式 context 必须覆盖所有公开字段。已经发布的 context 不得原地改变语义；任何语义
变化都必须发布新的版本 URI。

导入器必须使用仓库中经过哈希校验的本地 context，不能为了打开项目而任意访问远程
context。这既保证离线使用，也避免远程内容变化和网络安全问题。

## Branchloom JSON-LD Profile

JSON-LD 允许很多等价写法。为了让 Git diff 稳定，Branchloom 只使用一个受限 Profile：

- 每个实体文件只有一个顶层节点。
- 顶层节点必须有 `@id` 和 `@type`。
- 实体文件不使用自由形式的 `@graph`。
- 可以被引用的节点必须有稳定 `@id`。
- 日期、事件参与者等不能独立引用的值对象可以省略 `@id`。
- 文件不能通过局部 context 改写公共字段含义。
- 不给 `@id`、`@type`、`@context` 定义别名。
- 所有引用都写成完整的 `urn:uuid:<uuid>`。
- 写入器必须输出本规范定义的 compacted JSON-LD。

第三方读取器可以使用任何符合 JSON-LD 1.1 的处理方式，但写入 Branchloom 仓库时必须
遵循此 Profile。

## ID、引用与公共字段

所有项目实体使用：

```text
urn:uuid:<lowercase-uuid>
```

例如：

```text
urn:uuid:018f96b5-ae11-73dc-a51c-412fa8f60c65
```

要求：

- UUID 使用小写标准连字符形式。
- 所有 `@id` 在项目内全局唯一，包括人物内部的姓名 ID。
- 文件名使用裸 UUID，不带 `urn:uuid:`。
- 外部导入已有可靠 UUID 时应保留；没有可靠 ID 时才生成新 UUID。

除项目外，活动实体都有以下公共字段：

```json
{
  "@context": "https://branchloom.app/context/v1",
  "@id": "urn:uuid:018f96b5-ae11-73dc-a51c-412fa8f60c65",
  "@type": "Person",
  "project": "urn:uuid:018f96ab-2f41-7d31-91f8-11a04ce81b21",
  "revision": 1,
  "createdAt": "2026-07-26T09:30:00.000Z",
  "updatedAt": "2026-07-26T09:30:00.000Z"
}
```

`revision` 从 `1` 开始，每次实体变化时递增。两个设备可以同时从 revision 3 修改出两个
revision 4，因此不能简单认为 revision 较大或时间较晚的一方正确。

## JSON 写法

规范写入器必须遵守：

- UTF-8，无 BOM。
- LF 换行。
- 两个空格缩进。
- 文件末尾一个换行。
- 不使用注释、尾随逗号、`NaN` 或 `Infinity`。
- 可选字段没有值时省略，不写 `null`。
- 必需空集合写为 `[]`。
- 必需但允许为空的文本写为 `""`。
- 集合型 URI 数组去重后按 URI 排序。
- 有显示顺序的对象使用 `sortOrder`，再按 `@id` 排序。
- 动态对象键按照 Unicode 码点排序。
- 相同逻辑数据必须产生相同字节。

不得使用 JSON5、YAML 或 JavaScript 对象字面量扩展。

## 日期

历史日期经常不精确，因此同时保存原始表达和可选标准化值：

```json
{
  "@type": "GenealogyDate",
  "display": "约清光绪二十年",
  "start": "1894-01-01",
  "end": "1894-12-31",
  "precision": "about"
}
```

`precision` 允许：

```text
exact | about | before | after | range | unknown
```

规则：

- `display` 是用户录入和看到的原始表达。
- `start`、`end` 是可选的标准化公历边界。
- 无法可靠换算时只保存 `display` 和 `precision`。
- 不得根据显示文字静默覆盖已经保存的标准化值。
- `start` 不得晚于 `end`。
- `range` 应同时提供 `start` 和 `end`。

## 项目

`project.jsonld` 保存项目本身：

```json
{
  "@context": "https://branchloom.app/context/v1",
  "@id": "urn:uuid:018f96ab-2f41-7d31-91f8-11a04ce81b21",
  "@type": "Project",
  "revision": 12,
  "name": "张氏家谱",
  "description": "山东支系资料",
  "defaultPerson": "urn:uuid:018f96b5-ae11-73dc-a51c-412fa8f60c65",
  "coverAttachment": "urn:uuid:018f9722-b6aa-72fe-a25c-c272cefc2c86",
  "createdAt": "2026-07-01T08:00:00.000Z",
  "updatedAt": "2026-07-26T09:30:00.000Z"
}
```

- `name` 去除首尾空白后不能为空。
- `defaultPerson` 必须引用当前存在的人物。
- `coverAttachment` 必须引用当前存在的图片附件。
- `backupSchedule`、`lastBackupAt` 等设备设置不进入项目文件。

## 人物与姓名

人物包含：

```text
names, sex, status, avatarAttachment,
birth, death, birthPlace, deathPlace,
biography, notes, sources
```

姓名是人物文件中的嵌套值，没有独立 ID。一个人物可以有多个姓名，但同一个人物内不能
保存重复姓名；其中恰好一个姓名使用 `primary: true` 标记为主姓名。

`sex`：

```text
female | male | nonbinary | unknown
```

`status`：

```text
living | deceased | unknown
```

`nameType`：

```text
personal | courtesy | art | genealogy | generation | childhood
former | pen | religious | posthumous | temple | honorific
alias | custom
```

要求：

- 每个活动人物至少有一个姓名。
- 每个人物恰好有一个主姓名。
- 姓名去除首尾空白后不能为空。
- 同一人物的姓名值不能重复。
- `custom` 姓名必须有 `customTypeLabel`。
- 头像引用附件 ID，不保存本地绝对路径或临时 URL。

## 关系

关系不是人物上的简单字段，而是独立实体，因为关系本身可以有日期、地点、来源和备注。

父母关系：

```text
category = parent
relationType = biological | adoptive | step | guardian
```

伴侣关系：

```text
category = partner
relationType = engaged | married | partner | separated | divorced
```

规则：

- 父母关系方向固定为父母或监护人 `fromPerson` 指向子女或被监护人 `toPerson`。
- 伴侣关系是对称关系，保存时两个 URI 按字典序归一化。
- 人物不能与自己建立关系。
- 不能存在完全重复的活动关系。
- 父母关系不能形成祖先环路。

兄弟姐妹、祖父母、孙辈等可以从基本关系推导，不保存重复边。

## 事件

事件包含：

```text
eventType, title, date, place, participants, sources, notes
```

参与者是结构化数组：

```json
{
  "@context": "https://branchloom.app/context/v1",
  "@id": "urn:uuid:018f9790-4c6b-7ca1-a5a0-e06d273bc417",
  "@type": "FamilyEvent",
  "project": "urn:uuid:018f96ab-2f41-7d31-91f8-11a04ce81b21",
  "revision": 1,
  "eventType": "marriage",
  "title": "张三与李四成婚",
  "date": {
    "@type": "GenealogyDate",
    "display": "2002年10月1日",
    "start": "2002-10-01",
    "precision": "exact"
  },
  "participants": [
    {
      "person": "urn:uuid:018f96b5-ae11-73dc-a51c-412fa8f60c65",
      "role": "新郎",
      "sortOrder": 0
    },
    {
      "person": "urn:uuid:018f96e8-60f2-755b-b6ae-e987bb011070",
      "role": "新娘",
      "sortOrder": 1
    }
  ],
  "sources": [],
  "notes": "",
  "createdAt": "2026-07-26T09:30:00.000Z",
  "updatedAt": "2026-07-26T09:30:00.000Z"
}
```

- `eventType` 和 `title` 不能为空。
- 每位参与者必须引用当前存在的人物。
- 同一人物、相同角色的组合不能在同一事件中重复。

## 其他实体

### 地点

```text
name, parentPlace, aliases, notes
```

地点父级必须属于同一项目，并且不能形成环路。

### 机构

```text
name, organizationType, aliases, parentOrganization,
place, validFrom, validTo, notes, sources
```

`organizationType`：

```text
company | government | imperial_court | military
education | religious | clan | other
```

机构父级不能形成环路。

### 履历

```text
person, careerCategory, organization, positionTitle,
department, regime, rankOrGrade, appointmentType,
jurisdictionPlace, appointedByPerson,
start, end, status, description, notes, sources
```

`careerCategory`：

```text
employment | civil_office | military_office | academic
religious_office | self_employed | other
```

- `positionTitle` 保存职位或官职原文。
- `status` 为 `current | former | unknown`。
- `current` 履历不能有明确结束日期。
- 同期履历合法，不能因为时间重叠而拒绝兼任或兼职。

### 称号

```text
person, titleType, value, customTypeLabel,
start, end, place, grantedByPerson, notes, sources
```

`titleType`：

```text
nobility | conferred-title | honorific-title | custom
```

官职和职业使用履历，不保存为称号。

### 来源

```text
title, sourceType, author, repository, url,
date, referenceCode, notes
```

`sourceType`：

```text
book | archive | web | interview | other
```

### 引用

引用把来源连接到具体资料：

```text
source, targetType, target, locator, excerpt, accessedAt, notes
```

`targetType`：

```text
person | person_name | relationship | event | career
```

`target` 必须引用与 `targetType` 匹配的数据。

## 图片和其他附件

JSON-LD 只保存附件元数据，实际内容放在 `media/` 并通过 Git LFS 传输：

```json
{
  "@context": "https://branchloom.app/context/v1",
  "@id": "urn:uuid:018f9722-b6aa-72fe-a25c-c272cefc2c86",
  "@type": "Attachment",
  "project": "urn:uuid:018f96ab-2f41-7d31-91f8-11a04ce81b21",
  "revision": 1,
  "name": "祖父照片.jpg",
  "mimeType": "image/jpeg",
  "sizeBytes": 284731,
  "contentHash": "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  "storage": {
    "@type": "GitLfsStorage",
    "path": "media/sha256/2c/2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
  },
  "createdAt": "2026-07-26T09:30:00.000Z",
  "updatedAt": "2026-07-26T09:30:00.000Z"
}
```

规则：

- `contentHash` 使用 `sha256:<64 个小写十六进制字符>`。
- 相同内容在一个仓库中只保存一份。
- 下载后先检查大小和 SHA-256，再放入本地附件目录。
- 客户端必须识别未下载的 LFS pointer，不能把 pointer 当成图片。
- 图片、PDF、音频和视频共用附件模型。
- `previewUrl`、绝对路径、缩略图缓存和本地缺失状态不进入 Git。

附件关联是独立实体：

```text
attachment, targetType, target
```

`targetType`：

```text
person | person_name | relationship | event | career | citation
```

相同附件和目标的组合不能重复。

## 删除与合并人物

所有业务实体都执行硬删除：删除提交直接移除对应的 `data/` 文件以及已经失效的引用，
不创建 tombstone，也不保留软删除字段。

同步以共同 Git commit 为 `base`。一方删除、另一方未修改时自动采用删除；一方删除、
另一方同时修改时必须产生冲突并交给用户处理，不能静默决定“删除获胜”或“修改获胜”。

Git 历史可能继续包含删除前的数据。删除当前文件不等于从所有 clone、fork 和历史提交中
彻底清除个人信息。

## 哪些数据不上传

以下内容只属于本地运行或可以重新计算，不进入项目仓库：

- SQLite、WAL 和 SHM 文件。
- 搜索索引和查询缓存。
- 自动生成的数据检查问题。
- 家谱画布坐标、缩放和平移状态。
- 当前中心人物、折叠分支和临时筛选。
- 撤销、重做和前端保存状态。
- 同步中的临时状态和错误。
- `backupSchedule`、`lastBackupAt` 等设备设置。
- 附件绝对路径、预览 URL、缩略图和本地缺失状态。
- GitHub token、OAuth 凭据、SSH 私钥和加密密钥。

用户手工创建的问题记录可以作为 `manual-issues` 实体保存；自动检查结果应在重建 SQLite
后重新生成。

## Git 提交

- 一个 commit 对应一次用户可理解的同步批次。
- 不为每次键盘输入创建 commit。
- commit 中的项目状态必须引用完整并通过校验。
- 新人物和新关系等原子业务操作必须进入同一个 commit。
- 首版不提供 Branchloom 快照功能。

建议 commit trailer：

```text
Branchloom-Operation: <uuid>
Branchloom-Device: <uuid>
Branchloom-Format: 1.0.0
```

设备 ID 用于诊断，不包含账号 token 或私人凭据。

## 多设备冲突

同步使用三个版本：

```text
base   = 上次成功同步的版本
ours   = 本地修改
theirs = 远端修改
```

基本规则：

- 只有一方修改的字段自动采用修改值。
- 双方把同一字段改成不同值时产生字段冲突。
- 姓名按规范化姓名值合并；同一姓名被双方改成不同值时产生冲突。
- 集合按元素 URI 合并。
- 一方删除、另一方修改同一实体时产生实体冲突。
- 合并关系后重新检查重复关系和祖先环路。
- 不能简单采用“时间最新”或“revision 最大”的版本。
- 不能只依赖 Git 文本冲突标记作为最终业务结果。

只有完整校验通过后，合并结果才能更新同步基线或推送远端。

## 从 JSON-LD 重建 SQLite

拉取数据后不能直接覆盖正在使用的数据库。安全流程是：

```text
拉取并合并 JSON-LD
  → 校验格式、context 和全部引用
  → 创建 branchloom.next.sqlite3
  → 应用最新 migrations
  → 单事务导入
  → 建立索引
  → foreign_key_check
  → 领域完整性检查
  → 原子替换正式数据库
```

失败时保留原数据库，并报告具体文件、实体 URI 和错误码。

首版可以完整重建。后续可以根据 Git diff 增量更新，但增量结果必须与完整重建完全等价。

## 完整性规则

导入器至少检查：

- 根清单、格式版本、required features 和 context 哈希有效。
- 每个文件通过对应 JSON Schema。
- 路径、文件名、`@id` 和 `@type` 一致。
- 实体 ID 全局唯一。
- 所有实体属于当前项目。
- 所有引用目标存在并且类型匹配。
- 每个人物都有有效主姓名。
- 地点和机构层级没有环路。
- 父母关系没有祖先环路。
- 当前履历没有结束日期。
- 引用和附件关联目标存在。
- 附件大小与 SHA-256 一致。

JSON Schema 负责单文件结构。跨文件引用、图环路、附件内容和合并规则由 Rust 领域层
负责，不能只靠 Schema。

## JSON Schema

正式实现需要发布 JSON Schema 2020-12：

```text
repository.schema.json
project.schema.json
person.schema.json
relationship.schema.json
event.schema.json
place.schema.json
organization.schema.json
career.schema.json
person-title.schema.json
source.schema.json
citation.schema.json
attachment.schema.json
attachment-link.schema.json
manual-issue.schema.json
```

Schema 应约束字段类型、必填字段、enum、UUID、URI、时间戳、哈希、数字范围以及基础条件
关系。

## 格式版本

`formatVersion` 使用语义化版本：

- major：不向后兼容的字段或语义变化。
- minor：增加可选字段、实体或兼容语义。
- patch：不改变数据语义的规范或校验修正。

客户端行为：

- 不理解 major 版本时必须拒绝写入。
- 不理解 `requiredFeatures` 时只能只读打开或明确拒绝。
- 不能保留未知字段的旧客户端不得写回新格式。
- context 一旦发布不得原地修改。
- 数据迁移必须生成正常 Git commit，不能在打开项目时静默重写历史。

## 与 SQLite、GEDCOM 和 `.blp` 的关系

| 格式 | 用途 | 要求 |
|---|---|---|
| Branchloom JSON-LD | Git 存储、同步、SQLite 重建 | 对 Branchloom 数据无损 |
| SQLite | 本地事务、查询和索引 | 可以由 JSON-LD 重建 |
| GEDCOM 7 / 5.5.1 / 5.5 | 与其他族谱软件交换 | 允许存在映射损失，必须报告 |
| `.blp` | 单文件导出、迁移和分享 | 对 Branchloom 数据无损；内部为 ZIP |
| CSV | 表格型交换 | 只覆盖用户选择的字段 |

`.blp` 是 GitHub 展开工作区的便携封装。解压后具有相同目录、结构化数据和附件布局，
但不包含 `.git`、本地同步基线、SQLite、缓存或凭据。

GEDCOM 导入会转换为稳定的 Branchloom 实体；导出 GEDCOM 时，无法表达的扩展资料会在
兼容性报告中提示，内部 JSON-LD 与 SQLite 模型不会为迁就 GEDCOM 而降级。

当前首版 GEDCOM 映射如下：

- 支持 UTF-8 与带 BOM 的 UTF-16，接受 GEDCOM 5.5、5.5.1 和 7.0 常见层级结构；ANSEL
  文件会被安全拒绝并提示先转换编码。
- `INDI` 映射人物、多个 `NAME`、`SEX`、`BIRT`、`DEAT` 和 `NOTE`；常见日期限定词
  `ABT`、`BEF`、`AFT`、`BET ... AND ...` 会转换为结构化日期精度。
- `FAM` 的 `HUSB`、`WIFE`、`CHIL`、`MARR`、`DIV` 映射亲子与伴侣关系；`PEDI adopted`
  映射收养关系。
- 生卒与婚姻地点按名称去重后映射为地点实体。
- 导出使用 GEDCOM 5.5.1 UTF-8，并写入 `_BRANCHLOOM_PROJECT_ID` 与 `_BRANCHLOOM_ID`
  扩展标签，使 Branchloom 往返导入时保持稳定 ID。
- 组织、履历、称号、独立事件、来源、引文、附件和维护问题暂不写入 GEDCOM；存在这些
  资料时导出结果会警告用户使用 `.blp` 保存完整备份。

## 隐私和安全

开源项目并不意味着族谱数据公开：

- 用户仓库默认必须为私有仓库。
- 私有 GitHub 仓库不是端到端加密。
- 在世人物资料同步前应提醒用户注意隐私。
- token 和密钥必须保存在系统钥匙串。
- 导入器必须限制 context、文件路径和媒体路径，防止目录穿越和任意网络访问。
- MIME 类型不能替代真实内容检查。
- 不可信的 HTML、SVG、PDF 等附件不能自动获得执行能力。
- 后续加密应定义独立 Profile，并保持解密后的 JSON-LD 语义一致。

## 实现者检查表

实现一个兼容写入器，需要完成：

- [ ] 一个项目一个仓库。
- [ ] 生成稳定 UUID 和 `urn:uuid:`。
- [ ] 按实体拆分、按 UUID 前缀分片。
- [ ] 输出规范化 JSON-LD。
- [ ] 固定并校验版本化 context。
- [ ] 提供全部 JSON Schema。
- [ ] 使用 Git 文件删除表达硬删除，并处理删除/修改冲突。
- [ ] 使用 Git LFS 和 SHA-256 保存附件。
- [ ] 处理 LFS pointer 未下载状态。
- [ ] 支持 base / ours / theirs 领域三方合并。
- [ ] 合并后重新执行全部图完整性检查。
- [ ] 在临时 SQLite 中导入并原子替换。
- [ ] 未知版本、未知 required feature 时安全拒绝写入。
- [ ] 任何失败都保留本地未同步修改。

实现一个只读工具，最低要求：

- [ ] 读取 `branchloom.jsonld`。
- [ ] 校验并加载本地 context。
- [ ] 解析 `data/**/*.jsonld`。
- [ ] 根据 `@id` 连接实体。
- [ ] 不执行或信任仓库中的脚本和附件。

## 验收标准

正式实现至少证明：

1. 同一项目重复导出产生完全一致的 JSON-LD。
2. 一万名人物的仓库能够保存和完整重建。
3. 从空数据库导入后，人物、关系、事件、来源和附件关联等价。
4. 图片通过 Git LFS 上传下载，并通过 SHA-256 校验。
5. 删除不会因为另一设备同步旧状态而静默复活。
6. 不同字段的并发修改可以自动合并。
7. 同一字段的不同修改产生可定位冲突。
8. 修改与删除冲突不会静默丢失。
9. 未知格式版本或错误 context 被安全拒绝。
10. 导入失败不会覆盖当前 SQLite。
11. 断网时可以继续编辑，联网后可以继续同步。
12. GEDCOM 导入导出不会改变 JSON-LD 内部扩展模型。

## 常见问题

### 为什么不直接提交 SQLite？

SQLite 是二进制数据库。Git 很难展示人物级 diff，也无法可靠合并两个设备同时修改的
数据库文件；运行中的 WAL 文件还会带来一致性问题。

### 为什么不把所有数据放在一个 JSON-LD 文件？

一个大文件会让无关人物的修改互相冲突，也不利于大型项目增量同步。实体分文件能让
Git diff 更小，冲突更容易定位。

### 可以手工编辑这些文件吗？

可以查看，也可以谨慎编辑，但手工修改后必须运行完整校验。错误 UUID、失效引用或环路
都可能让项目无法导入。

### GitHub 是唯一支持的远端吗？

不是。v1 首先设计 GitHub 集成，但格式只依赖 Git 和 Git LFS。其他兼容托管服务可以
实现相同仓库协议。

### 图片会不会进入 JSON？

不会。JSON-LD 只保存图片的名称、类型、大小、哈希和路径；图片内容由 Git LFS 保存。

### 删除数据后 GitHub 上还找得到吗？

当前版本不再展示该实体，但 Git 历史和其他 clone 可能保留旧内容。敏感数据需要单独的
历史清理和安全流程。

### JSON-LD 能直接导入其他族谱软件吗？

通常不能。其他族谱软件主要使用 GEDCOM。Branchloom 会负责 JSON-LD 与 GEDCOM 之间的
转换并报告无法映射的数据。

## 参考标准

- [JSON-LD 1.1](https://www.w3.org/TR/json-ld11/)
- [JSON Schema 2020-12](https://json-schema.org/specification)
- [FamilySearch GEDCOM](https://gedcom.io/specs/)
- [Git Large File Storage](https://git-lfs.com/)
