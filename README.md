# dsh-memory

DeepSeek Harness 的跨会话持久记忆：**模型自己判断值得记什么、自己写入、后续会话自动召回**的那一层。

这不是 `AGENTS.md` / `CLAUDE.md` —— 那层 dsh 已经由 [`@deepseek-ai/dsh-agent-instructions`](https://github.com/deepseek-ai/deepseek-harness) 做掉了，而且做得更完整。这里补的是它上面那一层：人没有写下来、但模型在干活过程中发现值得留住的事实。

## 由三个部件组成

**1. `memory` 工具** —— 模型可调用，五个动作：

| action | 作用 |
|---|---|
| `write` | 建/改一条记忆（`name` + `description` + `type` + `content`，可选 `scope`） |
| `read` | 按 name 读回全文；`names` 可一次取多条 |
| `list` | 列出索引摘要（不含正文），可按 `type` 过滤 |
| `search` | 按内容检索，返回命中片段 |
| `delete` | 删除一条并重建索引 |

**2. 一个常驻的 system-prompt section**（`order: 50`）—— 每次 prompt 组装时把索引注入上下文。

**3. 一个捆绑的 `memory-maintenance` 技能** —— 记忆库需要整体过一遍时用：合并重复、清理过期、修悬空链接。只在 host 挂载了 skills 服务时才注册，没挂载就静默跳过。

## 关键设计：索引常驻，正文按需

每条记忆在上下文里只占一行 `name — description`，模型看到相关的才用 `read` 拉全文，或用 `search` 直接按内容命中。几十条记忆只花几百 token，而不是把全部正文塞进每一次请求。

索引按 `type` 分组注入，`user` / `feedback` 在前 —— 这两类会改变模型的行为，`project` / `reference` 只是背景。

## 两层作用域

```
$DSH_HOME/memory/
├─ global/                    # 跨项目共享
│  ├─ MEMORY.md
│  └─ prefers-chinese.md
└─ C--Users-x-repo/           # 按 cwd 隔离
   ├─ MEMORY.md
   └─ otc-deploy-target.md
```

默认（`scope: layered`）两层同时可见，索引里全局条目标 `[global]`。写入默认落项目层，`write` 时传 `scope: "global"` 才落全局层。同名时**项目层遮蔽全局层**。

这样"这个人是谁、希望你怎么工作"可以写一次全项目通用，而"这个仓库在做什么"仍然不会串味。

单条记忆的格式：

```markdown
---
name: prefers-chinese
description: 用户要求所有回复使用中文
metadata:
  type: feedback
  created: 2026-08-21T03:11:07.412Z
  updated: 2026-08-21T03:11:07.412Z
---

所有回复用中文。

**Why:** 用户母语。
**How to apply:** 包括代码注释。
```

四种 `type`：`user`（这个人是谁）· `feedback`（希望你怎么工作，含原因）· `project`（在做什么，写绝对日期）· `reference`（外部资源指针）。正文里用 `[[other-name]]` 互链。

`created` 在同名更新时会被保留，`updated` 每次改写刷新。老格式（没有这两个字段）的记忆照常可读，时间戳落回文件 mtime。

## 性能

索引注入发生在**每一次 prompt 组装**，也就是模型每走一步都会跑一遍。天真实现是每次把目录里所有记忆全文读一遍再解析 —— 120 条记忆时这在本机实测约 **107 ms/次**，是白白加在每一轮上的延迟。

这里用签名缓存：每次只做一次 `readdir` + 每个文件一次 `stat`（不读内容），拼成 `文件名:mtime:size` 的签名。签名没变就直接返回上次的结果，连渲染都跳过；签名变了也只重读真正变过的那几个文件。同样 120 条记忆，**约 1.8 ms/次**。

自己写完的文件会显式失效缓存，不依赖签名 —— 同一毫秒内把一条记忆改成等长的另一份内容时 mtime 和 size 都不变，只靠签名会漏。外部进程（另一个会话、手工编辑）的改动则由签名捕获。

`search`、反向链接、悬空链接检测全部跑在这份缓存上，不额外碰磁盘。

## 配置

| key | 默认 | 说明 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 记忆根目录的父级 |
| `scope` | `layered` | `layered` 两层都可见；`project` 只按 cwd 隔离的那层；`global` 只共享层 |
| `cwd` | `$DSH_CWD` 或 `process.cwd()` | 决定项目 slug |
| `indexBudgetBytes` | `16384` | 注入索引的字节上限 |
| `maintenanceSkill` | `true` | 设为 `false` 则不注册捆绑技能 |

## 装法

**作为 preset 的一行**（推荐，这样是 agent-plane，每个 preset 自己决定要不要）：

```yaml
- id: memory
  name: /absolute/path/to/dsh-memory/index.js
```

preset 里绝对路径按原样解析（mount 会转成 `file:` URL 再 import，空格会被正确编码），相对路径按 preset 目录解析。npm 安装进 profile 之后可换成裸包名 `dsh-memory`。

**作为 profile bundle 的一行**（全局生效，但会落到 host 的全局层）：

```powershell
dsh plugin --profile <name> add <本包绝对路径>
```

本包根 `package.json` 声明了 `dsh.bundle.patch`，所以 `dsh plugin add` 会自动把它追加进该 profile 的 `dsh.profile.bundles` 并应用 `cordis.patch.yml` —— **不需要手工编辑 profile 的 package.json**。反过来说，路径指错时只会打一条 warning，不报错，是静默失效，装完记得确认插件真的挂上了。

捆绑技能要生效还需要该 preset 挂了 skills 服务（`skill-filesystem` / `tool-skill` 之类）。没挂就只是少一个技能，`memory` 工具和索引注入照常工作。

## 权限与副作用

装这个插件之前，它会碰什么、不会碰什么：

| | |
|---|---|
| **磁盘** | 只读写 `$DSH_HOME/memory/` 下自己那两层目录（`global/` 和项目 slug 目录）。不读、不写工作区里的任何文件。 |
| **网络** | 无。不发任何请求，也不带任何运行时依赖。 |
| **子进程** | 无。 |
| **生命周期脚本** | 无。纯 ESM，无构建步骤，`scripts` 里只有 `test`。所以从 git 直接装时不会撞上 pnpm 对 `prepare` 的构建门禁。 |
| **host 服务** | `tools`、`systemPrompt` 必需，缺任一在装配时立即报错而不是静默降级；`skills` 可选，只用来注册捆绑技能。 |
| **上下文** | 注入一个 `order: 50` 的 system-prompt section，默认上限 16 KiB（`indexBudgetBytes` 可调）。不注入记忆正文。 |

**信任边界**：记忆正文是模型自己写进去的，属于不可信文本。注入前会转义 `</system-reminder>`，`description` 里的换行会被压平，所以记忆内容既关不掉插件自己的注入框，也塞不进第二个 frontmatter 头。但记忆**内容本身**仍然会被模型当作背景读到——注入的措辞明确说了那是过去的记录、不是用户当前的指令，不过如果你的部署里有人能往 `$DSH_HOME/memory/` 里写文件，那等于能往每次请求的上下文里写字，按这个前提设权限。

## 卸载

`dsh plugin` 把参数转发给 profile 目录里的 pnpm，所以卸载就是 remove：

```powershell
dsh plugin --profile <name> remove dsh-memory
```

装在 preset 里的话，删掉那一行即可。

两种方式都**不会删记忆文件**——它们在 `$DSH_HOME/memory/` 下，是你的数据不是插件的。要一并清掉就手工删那个目录；只想清掉某个项目的，删对应的项目 slug 目录，`global/` 留着。

## 几个刻意的取舍

**`MEMORY.md` 是给人看的镜像，不是注入源。** 每层各有一份，写入/删除后从磁盘上真实存在的文件重建。模型看到的索引是每次组装时重新扫 `.md` 文件本身扫出来的，**不读 `MEMORY.md`** —— 手工编辑它对模型零影响。文件头部自己写了这句话，免得下次有人对着它改半天。

**索引是派生物，不做增量维护。** 手改坏、并发写、进程中途挂掉都不会让它和实际文件长期失配。

**超预算时按 type 优先级裁，不按字母序截尾。** 先保 `user` / `feedback`，同类里保最近更新的，并明确写出「还有 N 条被省略，用 `list` / `search` 够得到」。按名字尾部截断等于让字母表决定模型记得什么。

**记忆文本会被转义。** 记忆内容里的 `</system-reminder>` 字面量会被转义，模型写进记忆的文本关不掉插件自己的注入框。插件自己的框不转义。`description` 里的换行会被压平，塞不进第二个 frontmatter 头。

**重复和悬空链接只提示，不拦。** `write` 一条和已有记忆高度相似的新条目时会给出候选名；正文里 `[[链接]]` 指向不存在的记忆时会点出来；`delete` 掉被别人引用的记忆时会说明哪些引用会悬空。判断权留给模型。

**损坏的文件被跳过，不影响其余。** 没有 frontmatter 或读取失败的 `.md` 不进索引，其他记忆照常工作。整个 section provider 外面还有一层兜底：记忆库坏了也只是不注入，不会让会话起不来。

**注入的措辞明确说了这是背景、可能过时。** `read` 一条超过 14 天的记忆时，结果里会直接标出它有多旧，并提醒先确认它提到的东西还在。

## 测试

```bash
npm test
```

45 个用例，两个文件：`test/memory.test.js` 覆盖插件装配、工具的五个动作、分层与遮蔽、链接与重复提示、注入转义、预算裁剪、`output.schema` 一致性；`test/store.test.js` 覆盖缓存的正确性与性能 —— 包括"内容被等长替换且 mtime 复原时确实没读盘"这种直接验证缓存生效的用例。

## 与 Claude Code auto-memory 的关系

行为目标是对标它：一条事实一个文件、四种 type、`[[name]]` 互链、索引常驻上下文、读取时提示陈旧度、配一个维护技能。实现是独立写的，提示词措辞、分层作用域、签名缓存、`search` / 批量 `read` / 链接图这些都是本包自己的。

## License

MIT
