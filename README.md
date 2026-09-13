# dsh-astrbot-ingress

> HTTP ingress that lets [AstrBot](https://astrbot.app/) drive a local
> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent:
> AstrBot stays the IM gateway, DSH does the coding.

把 [AstrBot](https://astrbot.app/) 接到本机 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：AstrBot 继续当 IM（OneBot / 官方渠道），DSH 当写代码的脑。

```
QQ / NapCat ──OneBot──▶ AstrBot ──HTTP──▶ 本插件 :3188 ──▶ ctx.agents
```

不绑定某一台电脑的盘符：同机、Docker、换工作区都只改配置。

## 快速开始（只有一个必填项）

```bash
# ① DSH 侧
dsh plugin --profile web add github:CCYellowStar2/dsh-astrbot-ingress
# 重启 dsh web；控制台出现 "listening on http://127.0.0.1:3188" 即成功
```

② AstrBot 侧装 [`astrbot_plugin_dsh`](https://github.com/CCYellowStar2/astrbot_plugin_dsh)
（WebUI 插件页填仓库地址，或在插件市场搜「DSH 桥」），重载插件。

③ **唯一要填的配置是 `token`**：抄 `%DSH_HOME%/dsh-astrbot-ingress/config.json` 里的那段，粘进
AstrBot 插件配置的 `token`。（AstrBot 与 DSH 同一台机器时**连这个都能留空** —— 插件会读
`%DSH_HOME%/astrbot-ingress.json` 这个信标文件。）

④ 回聊天窗口发 `/dsh 你好`。

**地址不用填**：`ingress_url` 留空时会自己探 —— 同机信标文件 → `host.docker.internal:3188` →
`127.0.0.1:3188` → 你列的候选，`/health` 第一个通的才用。**文件也不用挂盘**：入站大附件走一次性
URL（`/api/file/<token>`，DSH 自己下载），出站文件这边看不到时插件向 ingress 要一次性凭证拉过来再发。

| 你的情况 | 除了 `token` 还要填什么 |
|---|---|
| AstrBot 与 DSH 同一台机器 | **什么都不用**（`token` 也留空） |
| AstrBot 在 Docker、DSH 在宿主机（官方 compose） | **只填 `token`** |
| Linux 上的 Docker | 同上 + compose 加 `extra_hosts: ["host.docker.internal:host-gateway"]` |
| 宿主机映射端口不是 `6185`（如 `6185 → 10000`） | `inbound_url_candidates` 填宿主端口（`10000`）—— 只影响走 URL 的那条入站通道 |
| ingress 不在 `3188` / 不在同一台机器 | `ingress_url`（或 `ingress_url_candidates`） |
| AstrBot 与协议端（NapCat/SnowLuma）分容器且挂载点不同名 | `send_protocol_path`（+ 需要时 `send_outbox_dir`） |

```yaml
# compose 里给 AstrBot 的那两行（Linux 才需要；Windows/macOS 的 Docker Desktop 自带）
services:
  astrbot:
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

## 安装

### 1. DSH 侧插件

```bash
# npm（推荐：预构建产物，不用为构建脚本额外授权）
dsh plugin --profile web add dsh-astrbot-ingress

# 或从 GitHub 直接装（plugin add 转发给 pnpm，支持 github: / git+https: / 本地路径）
dsh plugin --profile web add github:CCYellowStar2/dsh-astrbot-ingress

# 或先 clone，再装本地目录
git clone https://github.com/CCYellowStar2/dsh-astrbot-ingress
dsh plugin --profile web add ./dsh-astrbot-ingress
```

重启 `dsh web`，控制台应出现：

```
dsh-astrbot-ingress: listening on http://127.0.0.1:3188
```

Token 写在 `%DSH_HOME%/dsh-astrbot-ingress/config.json`（Linux/macOS 通常是 `~/.dsh/dsh-astrbot-ingress/config.json`）。
顺手还会把**实际端口 + token**写进 `%DSH_HOME%/astrbot-ingress.json`（0600，每 30 秒刷新），
**同机**的 AstrBot 插件自动读它——所以同机部署不用手填地址和 token。

### 2. AstrBot 侧插件

把 `astrbot_plugin_dsh/` 拷进 AstrBot 的 `data/plugins/`（或在 AstrBot WebUI 的插件页用仓库地址
`https://github.com/CCYellowStar2/astrbot_plugin_dsh` 安装），再重载插件。**同机**：`ingress_url` 与
`token` 留空即可（自动读上面的信标文件）；**AstrBot 在容器里**：填 `http://host.docker.internal:3188`
与手抄的 token。插件自身的说明见 [`astrbot_plugin_dsh`](https://github.com/CCYellowStar2/astrbot_plugin_dsh)。

## 配置

### DSH 侧（profile 的 `cordis.patch.yml`）

```yaml
- id: dsh-astrbot-ingress
  config:
    host: 127.0.0.1
    port: 3188
    cwd: ''                   # 默认工作区；留空 = DSH 已登记的第一个工作区
    reasoningMode: first-line # off | first-line | full
    showToolCalls: true
    toolLineBatch: 5
    progressMode: digest      # digest | full | minimal
    progressIntervalSec: 60   # 10-300
    beacon: true              # 写 ~/.dsh/astrbot-ingress.json（端口+token）供同机 AstrBot 自动发现
```

| 项 | 默认 | 说明 |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `3188` | 默认只监听本机 |
| `cwd` | 空 | 默认工作区；留空则用 DSH 已登记的第一个 |
| `maxMessageChars` | 1500 | 单条消息上限（超出自动切块） |
| `approvalTimeoutSec` | 600 | 审批 / 提问等你回答的上限 |
| `progressMode` | `digest` | 过程怎么发（见下） |
| `progressIntervalSec` | 60 | `digest` 的汇报间隔（10-300），**必须小于 AstrBot 的 `timeout_sec`** |
| `reasoningMode` | `first-line` | 思考内容：`off` / 只发第一行 / `full` 全文 |
| `showToolCalls` | 开 | `full` 档是否发工具行；`digest` 档是否把工具次数写进汇报 |
| `toolLineBatch` | 5 | `full` 档连续工具行并成一条（1 = 每条单发） |
| `beacon` | 开 | 把实际端口与 token 写进 `%DSH_HOME%/astrbot-ingress.json`（0600），供同机 AstrBot 自动发现；不想写就设 `false` |
| `inboundUrlMaxMb` | 200 | URL 入站的单文件上限（AstrBot 侧 `inbound_url_max_mb` 也要够） |
| `inboundUrlTimeoutMs` | 60000 | 单个 URL 的下载超时 |
| `outboundUrlMaxMb` | 200 | 出站文件「拉取凭证」的单文件上限（AstrBot 侧 `outbound_pull_max_mb` 也要够） |
| `endGraceMs` | 1200 | 每条助手消息的**最后一段**只压这么久等 `turn/end` 来拼 `—— 本回合结束`；等不到就先发正文。**别设太大**（设成几千毫秒就会重新出现「正文慢一拍」的手感） |
| `traceLog` | 关 | 诊断追踪：把 `adopt-turn` / `drop-stale` / `grace-flush` / `turn-end` 写进 `%DSH_HOME%/dsh-astrbot-ingress/trace.log`（>1MB 自动归档 `.old`）。只在排查跨进程时序时开 |

过程档位通常由 AstrBot 侧的 `progress_mode` 逐次带过来，这里的值只是「请求没带」时的兜底：

| 值 | 群里看到 |
|---|---|
| `digest`（默认） | 每 `progressIntervalSec` 秒一条 `⏳ 已跑 3 分钟 · 工具 7 次 · 最近：edit · bash` |
| `full` | 实时发思考首行 + 工具行 + 心跳摘要 |
| `minimal` | 过程不出声 |

三档都照发：最终结果、文件、报错、`任务已停止`、附件提示、权限确认，以及 `—— 本回合结束`。

### AstrBot 侧

| 项 | 同机 | AstrBot 在 Docker、DSH 在宿主机 |
|---|---|---|
| `ingress_url` | **留空**（自动读 `%DSH_HOME%/astrbot-ingress.json` 里的实际端口） | **一般也留空**（自动探 `host.docker.internal:3188`）；只有 ingress 不在默认端口 / 不在本机才手填 |
| `token` | **留空**（同上，从信标里读） | 与 DSH `config.json` 相同（**唯一的必填项**） |
| `allow_users` / `allow_groups` | 空 = 仅管理员 | 同左 |
| `send_file_mode` | `direct` | `auto`（出站文件有拉取兜底；出站图片 / 视频要共享目录时才填 `shared`） |
| `send_protocol_path` | 留空 | 出站图片 / 视频要落盘给协议端时填，如 `/app/napcat/data/dsh-outbox`、`/app/snowluma-data/dsh-outbox` |
| `send_outbox_dir` | 留空 | 仅当两边**挂载点不同名**时填（AstrBot 侧那个名字） |
| `inbound_share_dir` | 留空 | 入站大文件（>12MB）暂存目录（AstrBot 侧）。**同机留空即可** —— 自动用 DSH 当前工作区下的 `.dsh-inbox`；分容器才填，如 `/mnt/d/proj/.dsh-inbox` |
| `inbound_dsh_prefix` | 留空 | 仅分容器时填：同一目录在 DSH 侧的写法，如 `D:\proj\.dsh-inbox`（同机两边是同一个路径） |
| `inbound_url_base` | 留空 = 自动探测 | **URL 入站**：DSH 能访问到的 AstrBot 基址（**宿主视角**），如 `http://127.0.0.1:10000`。填了就固定用它 |
| `inbound_url_candidates` | 空 | URL 入站的候选（裸端口或完整地址）。宿主机映射端口不是 6185 时写这里，如 `10000`；插件会让 DSH 侧先真取一次，第一个通的才用 |
| `ingress_url_candidates` | 空 | ingress 地址的额外候选；留空时内置 `host.docker.internal:3188` / `127.0.0.1:3188`，自动探测 |
| `outbound_pull` | 开 | 出站文件本地看不到时从 ingress 拉（Docker 下免挂盘） |
| `inbound_url_mode` | `auto` | `auto`=只有 >12MB 走 URL；`always`=全走；`off`=关 |
| `trace_delivery` | 关 | 诊断：每轮在 AstrBot 日志里多几行 `[dsh-trace]`（排「慢一拍」「顺序不对」时开） |

**大多数情况不用管这一节**：只填 `token`，出站文件走上面的 `outbound_pull` 兜底、入站大附件走 URL，
挂盘是可选的老办法。还有一种通用做法是填 AstrBot 主配置的 `callback_api_base`（协议端能访问到的地址，
如 `http://astrbot:6185`）—— 出站图片 / 视频也会注册成 URL 交给协议端下载。两者都没配、且协议端与 AstrBot
分容器时，才需要共享目录并填 `send_protocol_path`。

要挂共享目录时，配置里填的都是容器内视角，在 compose 里把同一块盘挂成同一个路径最省事：

```yaml
services:
  astrbot:
    volumes:
      - ./napcat-data:/app/napcat/data   # 出站：与协议端挂同一路径
      - "D:/:/mnt/d"                     # 入站：DSH 要能读到 AstrBot 写的附件
  napcat:
    volumes:
      - ./napcat-data:/app/napcat/data   # 与 AstrBot 完全相同的挂载点
```

容器里若设了 `HTTP_PROXY`，插件会 `trust_env=False` 直连，避免被代理成 502。完整的部署对照表见 [`astrbot_plugin_dsh`](https://github.com/CCYellowStar2/astrbot_plugin_dsh#部署与共享目录)。

## 用法

唤醒词默认 `/dsh`（可改）。群聊需要管理员，或把群号填进 `allow_groups`。

```
/dsh <任务>              /dsh status
/dsh ws [n|路径]         /dsh ls                 /dsh use <n|短id>
/dsh new                 /dsh end                /dsh stop
/dsh steer <话>          /dsh rename <标题>
/dsh model [n|provider/model] [effort]           /dsh perm [n|名字]
/dsh compact             /dsh last [N]           /dsh send <路径>
```

- `status` 报上下文占用（百分比 / 已用 / 上限 / 剩余）与累计 token 构成
- `model`、`perm`、`compact`、`ws` 只作用于当前绑定会话，且是 durable 的
- `last [N]` 从会话日志补发最近 N 条助手回复，用于超时或重连后找回已跑完的结果
- 会话默认**一个群共用一条**；要按人隔离就把 AstrBot 侧 `session_scope` 切成 `user`（想共用的人各自 `/dsh use <同一个短id>`）

绑定之后**引用机器人的回复**即可续聊；官方 QQ 群还可以 `@机器人 + 说话`。带图 / 文件：`/dsh 看看这张图` 并附图，或（已绑定的会话里）直接发附件；官方 Bot 也可以**引用一张图 + `@机器人`**。附件经 HTTP 传到 DSH，落在当前工作区 `.dsh-inbox/`。

DSH 反问（`ask_user_question`，含 plan 模式的计划确认）也会发到聊天窗口：回 `1`、`1,3`、`答 你的说法`、`取消`，或引用那条再说；QQ 与 DSH 网页**并行，谁先答算谁的**；超时与 `取消` 都不会替你选。**在 QQ 里答完之后，网页端那张提问卡片会被同步收掉**（0.3.8 起；此前会一直留在输入区，连超时作废之后都还在）。

## HTTP

| 接口 | 说明 |
|---|---|
| `GET /health` | 存活检查；返回 `capabilities`（本版本支持的可选能力，用来判断对面是不是新代码） |
| `GET /binding?umo=...` | 该会话是否已绑定 DSH（Bearer） |
| `POST /probe-url` | URL 入站前的探测：真去取一次那个 URL，只读一小段就断开（Bearer） |
| `POST /file-token` | 出站文件的拉取凭证：`{path, umo}` → 一次性 120 秒 token（Bearer） |
| `GET /file/<token>` | 用上面的凭证取文件（一次性；token 即凭据） |
| `POST /inbound` | 入站消息（Bearer）；JSON，附件可用 `files[].data`（base64）或共享目录路径 |

## 安全

- 默认只绑 `127.0.0.1`，不要把 `3188` 暴露到公网
- 出站文件限制在工作区内，并拒绝 `.ssh` / `.env` 等敏感路径段

## 开发

```bash
npm test        # node:test，跑 lib/pure.js 的纯函数单测
```

纯逻辑（分块、`[SEND_FILE]` 解析、消息抽取、路径校验、过程汇报文案）全在 `lib/pure.js`，与 cordis / 宿主无关，可直接单测；`lib/index.js` 只放插件装配与 I/O。改动记录见 [CHANGELOG.md](https://github.com/CCYellowStar2/dsh-astrbot-ingress/blob/main/CHANGELOG.md)，实现取舍与排障笔记见 [docs/design-notes.md](https://github.com/CCYellowStar2/dsh-astrbot-ingress/blob/main/docs/design-notes.md)。

## 技能

`skills/dsh-qq-send-file/SKILL.md` 教模型用 `[SEND_FILE: 绝对路径]` 把文件发回聊天窗口。装上本插件并重启 `dsh web` 后会通过 `ctx.skills.registerProvider` **自动进技能目录**（source=bundled），不必手工拷到 `~/.dsh/skills`。
