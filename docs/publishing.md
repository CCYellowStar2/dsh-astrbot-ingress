# 发布记录与流程

本仓库是**唯一源码**：DSH 侧插件在根目录，AstrBot 插件在 `astrbot_plugin_dsh/`。
AstrBot 插件另有一个**镜像仓库**，用 `scripts/sync-plugin-mirror.mjs` 同步。

## 已发布（0.2.0）

| 产物 | 地址 |
|---|---|
| DSH 侧插件（源码仓库） | https://github.com/CCYellowStar2/dsh-astrbot-ingress |
| AstrBot 插件（镜像仓库） | https://github.com/CCYellowStar2/astrbot_plugin_dsh |
| npm 包 | `dsh-astrbot-ingress` —— **尚未发布**（npm 账号未注册）。**非必须**：DSH 的 `dsh plugin --profile web add github:CCYellowStar2/dsh-astrbot-ingress` 直接走 pnpm 的 git 安装即可 |

元数据已填：`LICENSE` 版权行 / `package.json` 的 `author`·`repository`·`homepage`·`bugs` /
`astrbot_plugin_dsh/metadata.yaml` 的 `author`·`repo`。README 之间用绝对 URL 互相链接
（npm 页面不解析相对路径）。

## 发新版本

1. **三处版本一起改**：`package.json` 的 `version`、`astrbot_plugin_dsh/metadata.yaml` 的
   `version`、`CHANGELOG.md` 新增版本小节。`metadata.yaml` 按 AstrBot 官方示例写**纯语义化版本**
   （`0.2.1`，不带 `v`——市场用它比对版本号，带前缀可能判不出「已是最新」）。
2. 跑测试：`npm test`（纯函数单测）与 `npm pack --dry-run`（确认 tarball 内容）。
3. 推源码仓库：

   ```bash
   git add -A && git commit -m "1.2.3: ..." && git push
   ```

4. 同步镜像仓库：

   ```bash
   gh repo clone CCYellowStar2/astrbot_plugin_dsh D:\dswk\.mirror\astrbot_plugin_dsh
   node scripts/sync-plugin-mirror.mjs D:\dswk\.mirror\astrbot_plugin_dsh
   cd D:\dswk\.mirror\astrbot_plugin_dsh && git add -A && git commit -m "0.2.1" && git push
   ```

   （克隆目录只当临时工作区；本机是 Windows，别用 `/tmp`。同步脚本会把 6 个文件拷过去，
   里面除 `metadata.yaml` 外的文件常因换行符被判「已修改」，`git diff --stat` 只认真实内容变化。）

5. 发 npm（**可选**，前提是注册了 npm 账号并 `npm login`）：

   ```bash
   npm publish --access public
   ```

   没发 npm 也能正常用：`dsh plugin --profile web add github:CCYellowStar2/dsh-astrbot-ingress`
   会由 pnpm 直接从 git 装。npm 的好处只是版本号可查、`npx` 一行装、以及出现在 npm 搜索里。

## 纪律

- **改插件代码只改本仓库的 `astrbot_plugin_dsh/`**，然后跑同步脚本；不要直接在镜像仓库里改，
  否则两边会漂。
- AstrBot 实际加载的那份（`<AstrBot>/data/plugins/astrbot_plugin_dsh/`）也是**产物**：
  改完本仓库要把它一起覆盖过去，并核对四份文件一致（`main.py` / `_conf_schema.json` /
  `metadata.yaml` / `README.md`）。
- 发布前确认占位符都已替换：搜 `<AUTHOR>` / `<GITHUB_USER>` / `<INGRESS_REPO>` / `<PLUGIN_REPO>`。

## DSH 插件市场（awesome-dsh-plugin）

条目已备好：`docs/marketplace-entry.yml`（分类 `remote`，另带 `tarball:` 指向 Release 里的预构建包）。
投稿规则见仓库的 `contributing.md`，要点：

- 只投**一个文件**：`data/plugins/CCYellowStar2__dsh-astrbot-ingress.yml`，内容就是本仓库
  `docs/marketplace-entry.yml`。README 由脚本生成，**不要手工改**。
- 仓库要声明 `dsh.bundle`（本仓库已有 ✅）、根目录有 `cordis.patch.yml` ✅、
  挂 `dsh-plugin` topic ✅。
- **仓库需创建满 1 天**（CI 自动查）。本仓库建于 2026-09-12T07:03Z，
  因此 **2026-09-13T07:03Z（北京时间 15:03）之后**才能提 PR，提前提会被 CI 判失败。
- 描述必须与代码一致（会人工核对），所以每次加删功能要回来改这里。

提交（示例）：

```bash
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
git checkout -b add-ccyellowstar2-dsh-astrbot-ingress
cp ../dsh-astrbot-ingress/docs/marketplace-entry.yml data/plugins/CCYellowStar2__dsh-astrbot-ingress.yml
git add -A && git commit -m "Add CCYellowStar2/dsh-astrbot-ingress"
git push -u origin HEAD
gh pr create --fill
```

### 预构建 tarball

Release 里挂了 `dsh-astrbot-ingress.tgz`（`npm pack` 产物）。市场条目用
`releases/latest/download/` 指向它，所以**每次发版都要用同一个文件名覆盖上传**，否则链接会跳到旧版本：

```bash
npm pack && mv dsh-astrbot-ingress-<版本>.tgz dsh-astrbot-ingress.tgz
gh api --method POST -H "Content-Type: application/octet-stream" --input dsh-astrbot-ingress.tgz \
  "https://uploads.github.com/repos/CCYellowStar2/dsh-astrbot-ingress/releases/<release-id>/assets?name=dsh-astrbot-ingress.tgz"
```

（`gh release upload` 在本机常因 GraphQL 端点 TLS 超时失败，用上面的 REST 上传更稳。）

## AstrBot 插件市场

AstrBot 用 GitHub 托管插件：市场按 `metadata.yaml` 的 `name` / `repo` 识别并拉取镜像仓库，
**不需要提 PR**，走网页发布页。

1. 注册 [AstrBot Cloud](https://cloud.astrbot.app) 账号（发布页要求登录，可用 GitHub 登录）。
2. 打开 <https://cloud.astrbot.app/publish>，填插件仓库地址
   `https://github.com/CCYellowStar2/astrbot_plugin_dsh`，提交审核。
3. 审核要点（[官方文档](https://docs.astrbot.app/dev/star/plugin-publish.html)）：
   - 压缩包 **≤ 16 MB**（本插件几百 KB，只要别把 `.git` / `__pycache__` 提交进去就没事；
     镜像仓库已有 `.gitignore` ✅）；
   - `metadata.yaml` 必填 `name` / `desc` / `version` / `author`，`version` 用语义化版本；
   - 可选 `short_desc`（紧凑 UI 一句话）/ `social_link` / `tags`（市场分类与搜索）——都已填 ✅。

#### 这条流水线长什么样（**别指望它开 PR**）

2026-09-12 实测：Cloud 是**自己一套审核库**，不是把提交转成 GitHub PR。

- 发布页前端要 **授权它读你的仓库**：`POST /market/plugins/parse/github`（带 `github_installation_id` +
  `github_repository_id`）解析 `metadata.yaml`；页面上 `claim_status` 不是 `claimed` 时会让你
  「安装 GitHub App / 认领仓库」，这一步没走完提交不成立。没有 GitHub App 时还能走 **zip 上传**。
- 提交进的是 Cloud 的库，只有登录后能看：**<https://cloud.astrbot.app/profile>**（我的提交与状态）、
  `/reviews` 是审核台。账号限额：同时最多 5 条在审、24 小时最多 10 次提交。
- **提交后卡在「等待安全检查」是正常的，别重复提交**：那是 Cloud 审核流水线的一站，不是让你过的验证码
  （验证码只出现在登录/提交那一步，是 Turnstile 或 hCaptcha，本机网络可达）。
  **自动提交也会走同一条队列**（推了新版本号时），所以那个状态可能压根不是你点的。
  流水线是：提交 → LLM 初审（`/admin/reviews/plugins/<slug>/rerun-llm`、`confirm-llm`）
  → **安全检查队列**（VirusTotal + Claude Code Agent，产出 `guard_summary` / `guard_findings`，可重跑）
  → `review-worker` 队列 → 通过/拒绝。审核台里还有个「安全检查前人工确认」开关，
  打开时得等审核员点一下版本确认才进队列。用户侧无事可做，等就行。
- **审核通过后上的是 Cloud 市场**（<https://cloud.astrbot.app/market>，2088 个插件），
  市场会用**镜像仓库的提交**自己打一个 zip 挂出来供一键安装。
  **本插件的实测记录（2026-09-12）**：08:08 提交 → 08:13 上架 0.2.0（`edf4cb0`，32 KB）；
  08:56 推 0.3.0（`5b2901b`）→ **09:03 自动上架 0.3.0**（35 KB）。
  包里就是仓库内容：`main.py` + `metadata.yaml` + `_conf_schema.json` + README/CHANGELOG/LICENSE，
  没有 `.git`/`__pycache__`；`claim_status: claimed`。
- **GitHub 那个集合仓库（AstrBot_Plugins_Collection）已经冻住了**：最后一条同步提交停在
  2026-07-31，我们上架后它并没有新增条目。所以「Cloud 通过后同步进集合仓库」这条老链路别再指望，
  上架以 Cloud 市场为准（下面那条人工 PR 路线因此更没必要了）。
- **分类是 Cloud 判的，作者选不了**：市场分类只有 三方集成 / 生活 / 工具 / 长期记忆 / 知识库 / 娱乐 / 其他
  这几项（`_app/categories-*.js`），`metadata.yaml` 里写 `category` 也不生效；本插件被判成「其他」。
  真想改得改描述措辞让初审改判，或让审核员手动改——不值得为它折腾，标签和搜索都能找到。
- **发新版本：只改 `metadata.yaml` 的 `version` 再推镜像仓库就行，Cloud 自己会发**（2026-09-12 实测）：
  推 0.3.0（`5b2901b`，08:56:09Z）后约 **5 分钟**被扫到（Cloud 09:01:21Z 自动建提交记录），
  再约 **2 分钟**走完审核并自动发布（09:03:14Z）——作者一个按钮都没点。
  所以**「发布页显示等待安全检查」不等于没检查就上架**：那正是这次自动提交在队列里，
  检查过了才写 `published_at`。手动 update 模式（发布页选已有插件重新解析 GitHub，
  版本号必须大于已发布版本，前端有 `publish.versionInvalid` 校验）仍在，但通常用不上。
- **「安全检查」具体扫什么**（记录在 `versions[].guard_findings`，两次都判了清白）：
  - `virustotal`：0.2.0 → `malicious=0, suspicious=0, harmless=0, undetected=63`；0.3.0 → `undetected=65`；
  - `claude-code`：一个 agent 读代码写结论，明确认可「botpy monkeypatch 是为读取官方引用附件的合法用途」
    「无 eval/exec、无外泄、网络只到用户配置的本地端点」，并确认**没有针对审核员的 prompt injection**。
- **查最新状态用 slug 详情接口**（列表接口会被 CDN 缓存，可能还给你上一版）：

  ```bash
  curl -s 'https://cloud.astrbot.app/api/v1/market/plugins/ccyellowstar2-astrbot-plugin-dsh-3f975a0741e1daf3' \
    | jq '.data | {latest_version, published_version,
                   versions: [.versions[] | {version, status, queue_status, published_at, guard_summary}]}'
  ```

  这里有每个版本的 `status` / `queue_status` / `guard_findings` / `published_at`。
- 已上架与否可以自查（公开接口，无需登录）：

  ```bash
  curl -s 'https://cloud.astrbot.app/api/v1/market/plugins?page=1&page_size=20&search=dsh' | jq '.data.total'
  ```

  （搜索参数是 `search`，不是 `query`/`q`；按名字单查的 `/market/plugins/<name>` 会 404，它认内部 ID。）

镜像仓库同时也能当「手动安装」入口：把整个目录拷进 `data/plugins/` 即可，
AstrBot 的插件管理页也支持直接填仓库地址安装。

### 备选：人工 PR（**别走这条了**，留个记录）

发布页的事本质就是往 [AstrBotDevs/AstrBot_Plugins_Collection](https://github.com/AstrBotDevs/AstrBot_Plugins_Collection)
的 `plugins.json` 追加一条，所以没有 Cloud 账号也能发 PR（2026-09-12 试过一条：PR #2114，
Sourcery 通过、`Validate Plugin Smoke` 停在 `action_required`，随后关闭）。
但那仓库**自 2026-07-31 起就没再同步过**，市场早改由 Cloud 驱动，提了也不会生效——应急才用。

真要走这条时的步骤与坑：

1. `gh repo fork AstrBotDevs/AstrBot_Plugins_Collection --clone=false`
2. 克隆自己的 fork，在 `plugins.json` **末尾**追加 `astrbot_plugin_dsh` 一条
   （字段：`display_name` / `short_desc` / `desc` / `author` / `repo` / `category` / `tags` / `social_link`；
   文件很长但**不按字母序**，新条目一律追加在最后，diff 才干净）。
3. 提 PR。CI 三件事：`jq` 过一遍 JSON、`curl -I` 每个 `repo` URL 可达、
   `scripts/validate_plugins/run.py` 把**改动的**插件 clone 下来用 AstrBot 真加载一次。
4. 首次贡献者的 workflow 会停在 `action_required`，等维护者点批准；PR 挂在那里就是「审核中」。

冒烟校验可以本地复现（用容器里现成的 AstrBot 源码树，不必等 CI）：

```bash
docker cp <fork>/scripts astrbot:/tmp/dsh-validate/scripts
docker cp <fork>/plugins.json astrbot:/tmp/dsh-validate/plugins.json
docker exec astrbot sh -lc 'cd /tmp/dsh-validate && python scripts/validate_plugins/run.py \
  --astrbot-path /AstrBot --plugin-name astrbot_plugin_dsh --report-path /tmp/dsh-validate/report.json'
```

坑：校验脚本要求插件**仓库根目录**直接有 `main.py` + `metadata.yaml`（本仓库满足）；
不要求 `category`，但市场分类靠它，取值只有 `entertainment` / `utilities` / `ai_tools` /
`integrations` / `productivity`。
