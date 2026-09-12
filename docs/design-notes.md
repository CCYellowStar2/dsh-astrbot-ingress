# 设计取舍与排障笔记

用户文档看 [`../README.md`](../README.md) 和 [`../astrbot_plugin_dsh/README.md`](../astrbot_plugin_dsh/README.md)。
这里放**为什么这么实现**、**踩过什么坑**、以及**出问题时从哪儿查** —— 都被 README 剔出去了，但都值得留着。
按时间顺序的改动记录见 [`../CHANGELOG.md`](../CHANGELOG.md)。

## 架构上的两个关键约定

1. **ingress 只持有 SSE 流，实际发送永远在 AstrBot 侧**（`event.send()`）。
   ingress 从不自己往聊天窗口发消息，它只把文本 / 文件 / 状态推给 AstrBot 的那条连接。
2. 因此 **ingress 里的 `umo` 纯粹是索引键** —— `state.sessions[umo]` 存 `{sessionId, cwd, senderId}`，
   会话、回合、待审批、待提问、进度、引用指纹全都按它索引。

第 2 条带来一个便利：**「会话隔离」可以只在 AstrBot 插件侧实现**。
`session_scope: user` 时插件把上桥的 umo 改写成 `umo#u<uid>`，ingress 一行都不用改，
所有按 umo 索引的状态自动跟着隔离。反过来也说明：**默认 `group` 模式下没有「只有我」这个维度** ——
键是群级的，想按人分只能在键上动手。

## 同机零配置（信标文件）

为什么不像市面上那几个插件那样直接调 DSH 的 `/api`？**因为那道门要签名 cookie**：DSH 的本地网关
给每个进程发一个随机 launch token（只在内存里，唯一出口是 `dsh web` 打印的 `/?token=…`），
`/api` 请求先过 Host/Origin 再验 cookie，没有就 401。2026-09-12 在本机 0.1.5-rc.1 上实测：
`/api/host.describe`、`/api/host/describe`、`/api/session/list`、带 `args` 包裹、加
`Origin` / `Referer` / `?token=` / 伪造 cookie —— **全部 401**。所以「零安装纯 HTTP 客户端」这条路
第三方插件拿不到东西（市场上那三个插件的代码里也确实没有任何 cookie/token 处理）。

我们反过来：**插件跑在 DSH 进程里**（`ctx` 级权限，能订阅 `session/event`、`approval/request`、
`user-questions/request`），再自己开一个带 Bearer token 的本地 HTTP 服务给 AstrBot。代价是
AstrBot 侧要填地址 + token —— 这部分用**信标**抹掉：

- ingress 启动后把 `{kind, version, host, port, url, token, cwd, pid, updatedAt}` 写进
  `%DSH_HOME%/astrbot-ingress.json`（0600），每 30 秒刷新，退出时删掉自己的（pid 不符就不动）。
- AstrBot 插件在 `ingress_url` / `token` 留空时读它（60 秒缓存；`updatedAt` 超过 10 分钟、
  或 `kind` 不是 `dsh-astrbot-ingress` 都当没有），读不到才回退 `127.0.0.1:3188`。
- **只在同机成立**：AstrBot 在容器里看不到宿主机 home，那种部署照旧手填 `host.docker.internal`。
- 纯函数在 `lib/pure.js`（`beaconPayload` / `parseBeacon` / `isBeaconFresh`），有单测；
  Python 侧对应 `read_ingress_beacon` / `_cached_beacon`。

## 正文「慢一拍」：最后一段不能压着等回合结束

症状：QQ 里上一条正文要等下一段正文才出现；严重时上一轮的答案出现在下一轮的流里。两个原因：

1. **每条助手消息的最后一段被压着等 `turn/end`**（只为拼上 `—— 本回合结束`）。中间只要隔着工具阶段
   （几十秒到几分钟），正文就一直压着。现在只压 `endGraceMs`（默认 1200ms）：`turn/end` 在这段时间内到
   就合并成一条，到不了就先把正文发出去，结束标记随后单独发。
2. **旧回合迟到的事件被算到新一轮头上**。事件原本只按 `sessionId` 找回合，而新消息进来时旧回合的 SSE
   已被掐掉（`被新消息打断`）。DSH 的每个事件都带 `turn: number`（`SessionEventMap` 里 `turn/start`、
   `turn/end`、`step/*`、`assistant/message`、`tool/call` 都有），所以现在按轮次号归位：被顶掉的旧轮次
   进 `staleTurns`，它迟到的事件（含 `turn/end`）直接丢掉；打断旧回合时先把压着的正文补发给它自己的流。

复现与验证都用**同一会话「上一条还在跑就发下一条」**的探针（连着 POST 两次 `/inbound`，看两个流各收到什么）：

- 旧行为：`T1 ack → +1252ms 被新消息打断 → 流关闭`；`T2 +534ms 收到 "AAAA ⏎ —— 本回合结束"`。
- 新行为：`T2 +2402ms 只收到 "BBBB ⏎ —— 本回合结束"`；`trace.log` 里是
  `supersede turn=6` → `drop-stale turn=6 assistant/message` / `turn=end` → `adopt-turn turn=7`
  → `turn-end turn=7 held=4 reason=completed`。

排查用的小工具：

- **别拿信标里的 `version` 当重载指示器**（2026-09-12 踩过并纠正）：信标每 30 秒刷新时是从**磁盘上的
  `package.json`** 现读版本的，所以**旧代码也会报出新版本号**——它只能证明「进程活着」。
  可靠判据只有两个：① 进程 **pid 变了**（重启 `dsh web`）；② 新代码独有的接口/字段在响应里出现了
  （例：`GET /probe-url` 返回 `{"ok":false,"error":"not found"}` 就说明跑的还是旧代码）。
  在 AstrBot 里点重载**不算** DSH 侧重载 —— ingress 是 DSH 宿主插件，得在 DSH 的设置 → 插件里重载，
  或重启 `dsh web`。
- `~/.dsh/dsh-astrbot-ingress/trace.log`：`adopt-turn` / `supersede` / `drop-stale` / `flush-held` /
  `grace-flush` / `turn-end` 每次一行，超过 1MB 自动归档成 `.old`。
- AstrBot 侧对应 `trace_delivery`（`[dsh-trace]` 前缀）：SSE 事件到达时刻 + 每条正文的发送时刻 + passive/active。
- **两个开关自 0.3.7 起默认关**（`traceLog: false` / `trace_delivery: false`）：慢一拍定位完成、实机验证
  通过后就不再常开 —— 平时白写磁盘、白占日志，排障时临时打开即可，排完记得关回去。
- **`/health` 的 `capabilities` 是唯一可靠的「活代码版本」判据**（0.3.8 起）：信标里的 `version` 是
  每次刷新现读磁盘 `package.json`，旧代码也会报新号；而 `capabilities` 写在代码里，读到的就是**正在跑的**
  那份代码支持什么。重载前后对比它，比对着 pid 猜靠谱。

## 提问卡片：两边并行 + 谁先答都要收卡片（0.3.8）

`ask_user_question` 走 `user-questions/request` 这条 waterfall：我们是 `prepend` 的监听者，**先把问题
发到 QQ，同时也调 `next()` 让网页端照常渲染**（独占过一版，用户同时开着网页时那张卡片点不了）。

坑在于**网页端的卡片只认自己那套生命周期**：`dsh-client-ui-user-questions` 在客户端注册一个 pending
interaction，只有 ① 它自己答了、或 ② host 给它发 cancel 帧，才会把卡片撤掉。我们在 QQ 侧抢先答完之后，
Cordis 那条 waterfall 已经返回了，但 gateway 里那条「转发给浏览器的待答事件」还挂着 —— 客户端什么都不知道，
卡片就永远留在输入区（实测：等到 10 分钟超时、模型都接着往下说完、整轮结束了，卡片还在）。

修法：QQ 侧一旦定下来（`answer` / `cancel` / `timeout`），就按 agent 在 `typertGateway.pendingRemoteEvents`
里找到那条事件，用 `settleRemoteEvent`（收到回答）或 `cancelRemoteEvent`（取消 / 超时）把它结掉 ——
gateway 的 `finishRemoteEvent` 会给每个客户端推 `{type:'cancel', eventId}`，卡片随之消失。
`cancelRemoteEvent` 会让下游那个 promise 失败，但调用方（我们的 `next()`）本来就挂了 `.catch`，不会变成
unhandled rejection。摸内部字段，所以整段包在 try/catch 里：拿不到就静默跳过，最坏是卡片多留一会儿。

## 卸载为什么一定要先收 SSE（0.3.8）

`server.close()` 的语义是「停止接受新连接，然后等**已有**连接结束」。QQ 那条 SSE 是长连接，可能挂着一整个
回合（几分钟到几十分钟），于是 `close()` 的回调永远不来 —— `ctx.effect` 的卸载函数卡住，插件在 DSH 的插件
列表里显示「卸载中」，`3188` 端口没了、信标被清掉，而且**之后每次热重载都卡在同一个点**（本次排障就是先被
它绊住，误判成「改动没生效」）。

现在的卸载顺序：① 给还开着的每个 turn 发 `done` + `res.end()`（正常收尾，AstrBot 侧能立刻知道是重载）；
② `clearBeacon()`；③ `server.close()` 与 `closeAllConnections()` 并用，并给 `close()` 加 2 秒上限。
顺带一条排障教训：看到「卸载中」先看看是不是还有长连接挂着 —— 这次就是我自己开的探针 SSE 把它按住的。

## 长消息分片与代码块

`splitForIm` 切块时看**围栏状态**（`openFence`）：断在未闭合的 ```` ``` ```` 里，就给本条补上闭合、
下一条用原语言标签重新打开。不这么做的话，长代码块被腰斩后两边各自渲染成一坨。注意判断要带上
「上一条带过来的 pending 围栏」，只看当前 head 会漏掉续片的闭合（写的时候踩过）。

## 过程显示（`progress_mode`）

- **档位由 AstrBot 侧决定、ingress 执行**：插件把 `progress_mode` / `progress_interval_sec`
  跟在每次 `/inbound` 里（`progress: {mode, intervalSec}`）。只有 ingress 分得清「过程」和「结果」，
  所以判断在那边做；请求没带这个字段时用 ingress 自己的 `progressMode` 兜底（旧插件不受影响）。
- **周期汇报同时是保活心跳**：AstrBot 那条 SSE 按「读空闲」算超时（`timeout_sec`，默认 600），
  所以 `progress_interval_sec` 必须更小。`minimal` 档一条都不发，就改为发 SSE 注释行 `: ping`
  （AstrBot 的解析器会忽略它，但字节确实到了，不会撞超时）。
- **等人工输入期间暂停汇报**：等你批准权限 / 回答提问时不是「在跑」而是「在等人」，
  周期行会跳过（`turn.awaitingHuman`）。
- **`—— 本回合结束` 任何档位都发**：它是「跑完了」的信号，不是过程噪音。
  曾经把它当过程一起砍掉，结果发完文件后用户不知道结束没有 —— 别再砍。

## 续聊判定（引用 / @）

- DSH 出站文本开头带**两个零宽空格**（`\u200b\u200b`）做隐藏标记：聊天里看不见，人格回复不会带。
- 标记失效（平台截断 / 重排）时退回**归一化指纹**：去空白与 markdown 后比前缀 40 字、后缀 30 字，
  再退到「本回合结束」等固定标记词。
- 引用**人格**的回复不能误判成 DSH 续聊 —— 所以判定只认标记 / 指纹 / 记录过的出站 id。

## 官方 QQ 通道

### 被动 / 主动消息

- 被动回复硬限制：同一会话 5 分钟内最多 5 次（`40034128`）。
- 走主动的办法是**发送前把 `event.message_obj.message_id` 置空**：C2C 由 AstrBot pop 掉该字段，
  群聊由 botpy 发 `msg_id: null`（与 `content` / `embed` 一样，接口接受）。
- 主动消息报 `40034105 主动消息失败, 无权限` **不等于没权益**：群聊要在开放平台给**该群**开启「主动通知」。
  撞到之后插件自动回退被动，并在**本进程内不再尝试主动**（否则每条都撞一次、刷日志）。

### 引用续聊与被引附件（这个结论被推翻过，记清楚）

- 入站事件里 **`message_reference` 官方压根不下发**。AstrBot 日志里那个
  `'message_reference': "{'message_id': None}"` 是 **botpy 用 `data.get("message_reference", {})`
  凭空造的空对象** —— 极容易看走眼，据此下过「官方拿不到引用」的错误结论。
- 真正的数据在 **`msg_elements`**：
  ```json
  {"msg_elements": [{"content": "<被引正文>", "message_type": 103, "msg_idx": "REFIDX_…",
                     "attachments": [{"content_type": "image/png", "filename": "…",
                                      "size": 47001, "url": "https://multimedia.nt.qq.com.cn/download?…"}]}],
   "message_scene": {"ext": ["ref_msg_idx=…", "msg_idx=…", "auth_token=…"]}}
  ```
  被引的**图 / 文件也在 `attachments[]` 里，且 `url` 可直接下载**。
- botpy 的模型里没有 `msg_elements`，会直接丢掉；而它的消息类声明了 `__slots__`。
  所以插件装了个 shim：**就地包 `botpy.message.GroupMessage.__init__`**（以及 `C2CMessage`），
  把原始 `data` 存成 `self.raw_payload`。
  - ⚠️ **不能替换 `botpy.connection.GroupMessage`**：AstrBot 自己也子类化了
    `botpy.message.GroupMessage`（`PatchedGroupMessage`），并在
    `ConnectionState.parse_group_message_create` 里**直接构造那个子类**，绕过 connection 里的名字。
  - AstrBot 的子类**没有声明 `__slots__`**，所以实例自带 `__dict__`，挂得上属性。
- 取用：`_official_quoted_text()` 读正文走续聊判定；`_official_quoted_media_segments()`
  把附件转成 `Image.fromURL` / `Video.fromURL` / `File(name, url)`，并进统一媒体收集流程
  （`convert_to_file_path()` 遇 http 会自动下载）。

## 提问桥（DSH 反问用户）

- `ask_user_question` 走的是和审批**并排**的另一条 waterfall 事件：`user-questions/request`
  （`@deepseek-ai/dsh-user-questions`，网页端由 `dsh-client-ui-user-questions` 接）。
  只接 `approval/request` 的话，QQ 永远收不到问题、DSH 一直干等。
- **QQ 与网页并行，谁先答算谁的**：ingress 一边把问题发到 QQ，一边照常 `next()` 让网页显示卡片，
  两边一起 `Promise.race`。网页那条**没人接或出错都不该影响 QQ**（失败即视作永不 settle）。
  最早做成「QQ 轮次独占」，结果群里在跑时网页那张卡片点不了 —— 人常常两边都开着。
- **命令词优先**：有提问挂着时 `stop` / `status` / `send …` 照旧当命令执行。
  曾经把 `stop` 当成「用户回答：stop」喂给模型。想回自由文本用 `答 …` 前缀绕开这个判断。
- **超时与 `取消` 绝不替你选**：plan 模式确认的选项里就有「批准」，替你选等于自动放行。
  超时 / 取消时工具带一句说明失败，模型自己接着往下走。
- 只有**发起那一轮的人**能在 QQ 里回答（和审批一致）。

## URL 入站（0.3.3 已实现）

Docker 部署不想挂共享盘时走这条：插件把附件登记成 AstrBot 的**一次性 URL**，ingress 自己去下载。

- 插件侧：`inbound_url_base`（**DSH 视角**的 AstrBot 基址，如 `http://127.0.0.1:10000` —— 宿主机端口，
  不是容器里的 6185）→ 用 `from astrbot.core import file_token_service` 拿单例，
  `register_file(local_path)` 得到 token，拼 `{base}/api/file/{token}`。
  ⚠️ **不能用 `callback_api_base`**：那是给协议端看的（Docker 里常是 `http://astrbot:6185`），
  宿主机上的 DSH 解析不了。也不能 `from astrbot.core.file_token_service import file_token_service`
  —— 单例挂在**包**上（`astrbot/core/__init__.py: file_token_service = FileTokenService()`），
  模块里只有 `FileTokenService` 类。
- 模式：`inbound_url_mode` = `auto`（默认，只有 >12MB 才走 URL）/ `always`（全走，彻底不要共享目录）/
  `off`。上限 `inbound_url_max_mb`（默认 200），DSH 侧还有 `inboundUrlMaxMb` 兜底。
- 为什么能匿名取：`/api/file` 在 AstrBot dashboard 的 `allowed_endpoint_prefixes` 里（token 即凭证，
  默认 5 分钟有效、单次）。宿主机 `GET /api/file/<假token>` 返回 404 而不是 401 就能确认路由可达。
- ingress 侧：`files[].url` → `downloadUrlToFile()`（`lib/fetchfile.js`，有单测）：流式写进
  `cwd/.dsh-inbox/`，边下边计数（超限立即中断并删半截文件）、`AbortController` 超时、失败清干净。
- 回退链：URL 失败 / 未配 base / 超过上限 → 共享目录 → base64 → 最后才是「太大」提示。
  大文件在 `auto` 模式下**优先**走 URL，所以「Docker 不挂盘 + 大附件」这条组合终于成立。
- **候选地址要「探测」而不是「猜」**：AstrBot 在容器里**看不到**宿主机把 6185 映射成了哪个端口，
  所以插件按 `inbound_url_base`（显式优先）→ `http://127.0.0.1:<dashboard 端口>` →
  `inbound_url_candidates` 依次试，但**每一步都先让 ingress 去真取一次**
  （`GET /probe-url?url=…`，5 秒超时、只读一小段就断开），第一个通的才用；结果（含失败）缓存 600 秒。
  这样猜错的代价只是多一次轻量请求，不会变成「回合跑到一半才发现附件没了」。
  - **token 是单次消费的**（`FileTokenService.handle_file()` 里 `staged_files.pop`），
    所以探测用的一次性 token 与真传用的必须**各登记一次**，不能复用。
  - 都不通时会在聊天里提醒一次并列出试过哪些地址 —— 比只说「太大」可操作得多。
- **⚠️ 探测请求必须用 `httpx.AsyncClient`（死锁坑，2026-09-12 实测）**：探测跑在 AstrBot 的事件循环里，
  而 ingress 要取的 `/api/file/<token>` 正是**同一个进程的 dashboard** 提供的 —— 用同步 `httpx.Client`
  会把事件循环占住，变成「我等我自己」，探测**必然稳稳超时**。
  现象很迷惑：真 token 每次都卡满 5 秒超时（还被日志误报成「不可达」），而**假 token 秒回 404**
  ——因为那条路不需要读文件，dashboard 有空回。教训：**在 AstrBot 插件里发 HTTP 请求，只要目标可能是
  自己的 HTTP 服务，就必须异步。**
- 出站不受影响（出站仍走共享目录或 AstrBot 的回调 URL）。

## 出站文件的「拉取兜底」（0.3.6）

出站文件过去要求**AstrBot 能直接读到那个文件**（`D:\x` → `/mnt/d/x` 的挂载约定）—— Docker 下
官方 compose 只挂 `./data`，DSH 产出的文件它根本看不见。现在多了一条兜底：

1. 先照旧试本地路径（挂了盘的用户零开销）；
2. 看不到 → `POST /file-token`（Bearer）带上 `{path, umo}`，由 ingress **按该会话的工作区**校验
   （工作区外、敏感路径一律拒绝，凭证 120 秒过期、只用一次）并返回一次性 token；
3. 插件 `GET {ingress_url}/file/<token>` 流式拉到自己的 `data/temp/` → 按原逻辑发出 → 用完删掉。

于是 Docker 官方 compose 下**出站文件也不用挂盘**了；协议端那一腿仍按原规则（OneBot 的
`File` 段会变成 `file:///绝对路径`，NapCat 官方 compose 里两边共用 `./data:/AstrBot/data`，
所以 AstrBot 的 `data/temp` 正好也是 NapCat 能读到的路径 ✅）。

**ingress 地址也做成候选**：`ingress_url` 留空时依次用 信标 → `host.docker.internal:3188` →
`127.0.0.1:3188` → `ingress_url_candidates`，用 `/health`（不需要 token）探一遍取第一个通的，
结果缓存 300 秒。Docker 下于是只剩 `token` 一个必填字段。

## 未来改进（尚未实现）

- **出站也走 URL**：现在出站文件依赖共享目录 / 回调 URL；若把「AstrBot 主动来取」反过来做成
  「DSH 推给 AstrBot 的 /api」，Docker 出站也能免挂盘（收益比对入站小，暂不做）。
- **`beacon` 只写端口不写 token**：查过 ACL 后判定没必要 —— token 本来就明文躺在
  `~/.dsh/dsh-astrbot-ingress/config.json` 与 AstrBot 的 `astrbot_plugin_dsh_config.json` 里，
  去掉 beacon 那份不减少任何暴露面，却会废掉「同机零配置」。真要收紧就管文件 ACL。

## 出站文件

- 从回复里剥掉 `[SEND_FILE: …]`，并校验路径**必须在工作区内**、且不含 `.ssh` / `.env` / `credentials`
  等敏感路径段；一次最多 4 个。
- 协议端目录**只在父目录确实存在时才用**，并且只补建最后一级 —— 绝不 `mkdir -p` 整条路径：
  猜出来的目录一旦被凭空创建，拷进去的文件协议端根本读不到，最后报一个很难懂的 ENOENT。

## 入站文件的两种搬运方式

入站要给 DSH 的是**文件本身**，只有两条路：

1. **base64 内联**：插件把字节放进 `POST /inbound` 的 JSON。零配置，但插件对 >12MB 直接判 `too_big`
   （ingress 的 `readBody` 上限 20MB，base64 膨胀约 33%，所以实际文件约 15MB 就撞墙）。
2. **共享目录传路径**：插件把文件写到约定目录，只把**路径**发过去 —— 无尺寸上限。

`callback_api_base` **只管出站**（AstrBot 把待发文件注册成 URL 让协议端下载），对入站毫无帮助。

**同机自动兜底**：`inbound_share_dir` 留空且 AstrBot 不在容器里（`_in_container()` 为假，
说明与 DSH 同一个文件系统）时，插件用 `<DSH 工作区>/.dsh-inbox`。
工作区从 `GET /binding` 的 `cwd` 拿（这个字段本来就有），缓存 5 分钟以便 `/dsh ws` 后刷新；
`inbound_dsh_prefix` 也不用填 —— 同机两边看到的是同一个路径。
分容器（AstrBot 在 Docker 里）不做兜底：容器内的路径在 DSH 侧根本不成立，必须显式填两个视角。

## 已知的平台侧问题

- **腾讯侧偶发 `result=120`**：`send_group_msg` 被 QQNT 偶发拒绝
  （实测约 1.7% 的群发送，`errMsg` 为空，重试通常就过），不是禁言 / 权限 / 退群 ——
  同一群同时间段有大量正常发言。当前**不做兜底**：失败会让那一轮少一条消息（AstrBot 记 `handle error`）。
  协议端日志在容器 `snowluma` 的 `/app/data/logs/snowluma-YYYY-MM-DD.log`。
- `40034128`：被动回复 5 次 / 5 分钟上限，见上。

## 排障入口

| 想查什么 | 去哪儿 |
|---|---|
| 这一轮是不是 QQ 发起的 | ingress 的 `%DSH_HOME%/dsh-astrbot-ingress/sessions.json`，看该 umo 的 `updatedAt` |
| 插件有没有被真正重载 / 出站原文 | `docker logs astrbot --tail N`（含零宽标记的原文） |
| 协议端发没发出去 | 容器 `snowluma` 内 `/app/data/logs/snowluma-*.log`（事件行会把机器人自己标的 `[自身]`） |
| AstrBot 实际加载的插件代码 | `docker exec astrbot cat /AstrBot/data/plugins/astrbot_plugin_dsh/main.py` |

**不要在 DSH 正在回复（回合进行中）时重启 AstrBot 容器或 `dsh web`** ——
两者都会掐断那一轮的 SSE 流：QQ 侧只收到前半段，日志里却**没有任何发送失败**，很容易误判成「长度被截断」。

## 测试与结构

```bash
npm test        # node:test，跑 lib/pure.js
```

- `lib/pure.js`：纯逻辑（分块、`[SEND_FILE]` 解析、消息抽取、路径校验、过程汇报文案、提问排版与解析），
  与 cordis / 宿主无关，可直接单测。
- `lib/index.js`：插件装配、HTTP/SSE、与 `ctx.agents` / `sessionController` / `permissions` 等打交道。
- AstrBot 侧 `main.py`：SSE 消费、发送（内联图片 / 视频 / 文件、官方主动消息）、捕获判定、
  botpy shim、媒体收集。
