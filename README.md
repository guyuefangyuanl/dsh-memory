# dsh-memory

DeepSeek Harness 的跨会话持久记忆：**模型自己判断值得记什么、自己写入、后续会话自动召回**的那一层。

这不是 `AGENTS.md` / `CLAUDE.md` —— 那层 dsh 已经由 [`@deepseek-ai/dsh-agent-instructions`](https://github.com/deepseek-ai/deepseek-harness) 做掉了，而且做得更完整。这里补的是它上面那一层：人没有写下来、但模型在干活过程中发现值得留住的事实。

## 由三个部件组成

**1. `memory` 工具** —— 模型可调用，六个动作：

| action | 作用 |
|---|---|
| `write` | 建一条或整条替换（`name` + `description` + `type` + `content`，可选 `scope`） |
| `read` | 按 name 读回全文；`names` 可一次取多条 |
| `list` | 列出索引摘要（不含正文），可按 `type` 过滤；附带待写清单 |
| `search` | 按内容检索，返回命中片段 |
| `edit` | 局部改写：按 `old_string` / `new_string` 锚点替换，或只换 `description` / `type` |
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

四种 `type`：`user`（这个人是谁）· `feedback`（希望你怎么工作，含原因）· `project`（在做什么，写绝对日期）· `reference`（外部资源指针）。正文里用 `[[other-name]]` 互链，**包括还没写的名字**——见下面「链到还没写的记忆是特性」。

`created` 在同名更新时会从实际写入的那一层保留（全局同名记忆被项目层遮蔽时也一样），`updated` 每次改写刷新。老格式（没有这两个字段）的记忆照常可读，时间戳落回文件 mtime。

## 性能

索引注入发生在**每一次 prompt 组装**，也就是模型每走一步都会跑一遍。天真实现是每次把目录里所有记忆全文读一遍再解析 —— 120 条记忆时这在本机实测约 **107 ms/次**，是白白加在每一轮上的延迟。

这里用签名缓存：每次只做一次 `readdir` + 每个文件一次 `stat`（不读内容），拼成 `文件名:mtime:size` 的签名。签名没变就直接返回上次的结果，连渲染都跳过；签名变了也只重读真正变过的那几个文件。同样 120 条记忆，**约 1.8 ms/次**。

自己写完的文件会同时失效文件缓存与合并索引缓存，不依赖签名 —— 同一毫秒内把一条记忆改成等长的另一份内容时 mtime 和 size 都不变，只靠签名会漏。外部进程（另一个会话、手工编辑）的改动则由签名捕获。

`search`、反向链接、悬空链接检测全部跑在这份缓存上，不额外碰磁盘。批量 `read` 在一次调用里只扫描各活动层一次，再用同一份索引快照计算存在性和反向链接，避免每读一条就重扫整个记忆库。

## 配置

| key | 默认 | 说明 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 记忆根目录的父级 |
| `scope` | `layered` | `layered` 两层都可见；`project` 只按 cwd 隔离的那层；`global` 只共享层 |
| `cwd` | `$DSH_CWD` 或 `process.cwd()` | 决定项目 slug |
| `indexBudgetBytes` | `16384` | 完整注入文本的 UTF-8 字节上限，含说明、标题和标签；`0` 关闭索引注入 |
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

## 模型与宿主兼容性

插件通过宿主的工具注册表提供能力，不自行创建模型客户端或选择模型。参数直接使用完整 JSON Schema，可被旧版 dsh 原样发送；字段保留基础类型、枚举和字符串数组，不依赖自动类型转换。

本地隔离安装并验证了 `@deepseek-ai/dsh-tools` / `dsh-system-prompt` 的 `0.1.0-rc.6`、`0.1.1-rc.2`、`0.1.2-rc.1`、`0.1.5-rc.2`：真实注册表装配、Schema 导出、六个动作、输出校验、prompt 组装及卸载。安装的 peer 范围显式包含这些 RC 系列；仅写 `^0.1.0-rc.6` 不会接受后续版本号的预发布版本。尚未覆盖的 alpha 系列没有自动放开。

| 情况 | 支持边界与排查 |
|---|---|
| 普通 Function Calling | 使用对象根的 JSON Schema；`action` 必填，动作专属参数按需提供。 |
| 模型参数不完整或类型错误 | 返回 `ok: false` 和具体字段错误；不会把字符串数字、`null` 或遗漏的替换文本悄悄转换后写入。不要给无关字段填 `null`，直接省略。 |
| PTC / 代码调用 | 宿主可从同一 Schema 生成工具 SDK；隔离测试检查 TypeScript 及宿主提供的 Python SDK 导出。 |
| 小上下文模型 | 调低 `indexBudgetBytes`，超长条目会被跳过，其余短条目仍可进入索引。预算连简短提示也放不下时不注入，工具仍可用。 |
| DeepSeek strict 模式 | 需要宿主和 provider 单独适配；本插件当前 Schema 面向普通工具调用，不宣称 strict 兼容。不要仅在上游强制开启 strict。 |
| 模型不支持工具调用 | 插件无法给模型增加工具能力，需要在宿主选择支持工具调用的模型。 |

[DeepSeek 官方工具调用文档](https://api-docs.deepseek.com/guides/tool_calls/)要求 strict 模式下所有属性必填且对象禁止额外字段；这与普通模式的可选参数契约不同。[dsh 工具开发文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md)也明确直接注册 JSON Schema 的工具需要自行校验输入。以上本地检查不等于真实模型 API 验收；模型名、endpoint、鉴权及思考模式的协议转换仍由宿主负责。

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

**超预算时按 type 优先级裁，不按字母序截尾。** 预算覆盖完整 UTF-8 注入文本，单条超长时跳过它继续考虑后续条目。 先保 `user` / `feedback`，同类里保最近更新的，并明确写出「还有 N 条被省略，用 `list` / `search` 够得到」。按名字尾部截断等于让字母表决定模型记得什么。

**记忆文本会被转义。** 记忆内容里的 `</system-reminder>` 字面量会被转义，模型写进记忆的文本关不掉插件自己的注入框。插件自己的框不转义。`description` 里的换行会被压平，塞不进第二个 frontmatter 头。

**局部编辑不经过 frontmatter。** `edit` 的 `old_string` 只在**正文**里匹配，改完之后 frontmatter 由插件重新渲染。所以无论锚点匹配到什么、`new_string` 里塞了什么，都改不动 `name` / `created`，也注入不进第二个文档头。替换按下标切片做，不走 `String.replace`——否则 `new_string` 里的 `$&`、`$1` 会被当成替换模式解释。锚点不唯一时直接拒绝并说明出现了几次，除非显式 `replace_all`。

**链到还没写的记忆是特性，不是错误。** `[[some-name]]` 指向一条尚不存在的记忆，记录的是"这件事值得单独写一条"。所以 `write` **不会**为此报警；这些名字被 `list` 收集成 `unwritten` 待写清单，按被引用次数排序——被最多条记忆惦记的那个，就是记忆库最明显缺的那块。`read` 也会把某条记忆里尚未写的链接单独列出来。

唯一需要修的情况是名字**曾经**存在过：`delete` 会点名谁还在引用它，让你决定这件事是搬走了（那就把引用指过去）还是不成立了（那就留着，它退回成一条待办）。

**近重复只提示，不拦。** `write` 一条和已有记忆高度相似的新条目时会给出候选名，判断权留给模型。

**损坏的文件被跳过，不影响其余。** 没有 frontmatter 或读取失败的 `.md` 不进索引，其他记忆照常工作。整个 section provider 外面还有一层兜底：记忆库坏了也只是不注入，不会让会话起不来。

**注入的措辞明确说了这是背景、可能过时。** `read` 一条超过 14 天的记忆时，结果里会直接标出它有多旧，并提醒先确认它提到的东西还在。

## 测试

```bash
npm ci --ignore-scripts --legacy-peer-deps
npm test
```

70 个用例，三个文件。`test/compatibility.test.js` 使用 Ajv 校验真实 JSON Schema、输入/输出契约，覆盖模型错误参数、漏传替换文本、完整索引字节预算、批量读取扫描次数和 RC 版本范围。其余：`test/memory.test.js` 覆盖插件装配、可直接发送给模型的工具参数 JSON Schema（issue #1）、工具的六个动作、分层与遮蔽、待写清单、近重复提示、注入转义、预算裁剪、`output.schema` 一致性，以及 `edit` 的几条边界（锚点不唯一、锚点碰不到 frontmatter、`$&` 是字面量、拒绝路径不落盘）；`test/store.test.js` 覆盖缓存的正确性与性能 —— 包括"内容被等长替换且 mtime 复原时确实没读盘"这种直接验证缓存生效的用例。

开发依赖仅用于测试；插件仍然没有运行时依赖。测试安装使用 `--legacy-peer-deps`，避免为纯单元测试自动装入整套宿主。CI 另行安装真实宿主，执行 `node scripts/host-smoke.mjs <宿主安装目录>`；单元测试矩阵覆盖 Windows / Linux、Node.js 22 / 24。

## 与 Claude Code auto-memory 的关系

行为目标是对标它：一条事实一个文件、四种 type、`[[name]]` 互链（包括"链到还没写的名字是特性"这个立场）、索引常驻上下文、读取时提示陈旧度、配一个维护技能。实现是独立写的，提示词措辞、分层作用域、签名缓存、`search` / 批量 `read` / `edit` 局部改写 / 待写清单这些都是本包自己的。

有一处它更强而本包补齐得晚：Claude Code 的记忆是普通文件，可以用通用编辑工具改一句话；本包的记忆在 `$DSH_HOME` 下、模型只能走 `memory` 这一个接口，所以 v0.2.1 才补上 `edit`。反过来，本包的索引是从文件派生的，不像手工维护的 `MEMORY.md` 那样会和真实文件漂移。

## License

MIT
