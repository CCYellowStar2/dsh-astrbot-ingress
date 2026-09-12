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

## 未来改进（尚未实现）

- **URL 入站**：让 Docker 部署也能「两边都不挂共享盘」。做法是 ingress 的 `files[]` 支持 `url`
  （流式下载进 `cwd/.dsh-inbox/`），插件侧用 AstrBot 的
  `BaseMessageComponent.register_to_file_service()`（`callback_api_base` + `/api/file/{token}`）
  把本地附件变成 URL。
  - ⚠️ 需要一个**独立于 `callback_api_base` 的 DSH 视角基址**（如 `inbound_url_base`）：
    `callback_api_base` 是给协议端看的（Docker 里常是 `http://astrbot:6185`），宿主机上的 DSH 解析不了。
  - 需要有回退链（URL 失败 → 共享目录 → base64）与下载超时 / 大小上限 / token 过期处理。
  - 收益只对「Docker 且不想挂共享盘」的用户成立；同机部署已由自动兜底覆盖。

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
