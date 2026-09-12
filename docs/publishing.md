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

1. 注册 [AstrBot Cloud](https://cloud.astrbot.app) 账号（发布页要求登录）。
2. 打开 <https://cloud.astrbot.app/publish>，填插件仓库地址
   `https://github.com/CCYellowStar2/astrbot_plugin_dsh`，提交审核。
3. 审核要点（[官方文档](https://docs.astrbot.app/dev/star/plugin-publish.html)）：
   - 压缩包 **≤ 16 MB**（本插件几百 KB，只要别把 `.git` / `__pycache__` 提交进去就没事；
     镜像仓库已有 `.gitignore` ✅）；
   - `metadata.yaml` 必填 `name` / `desc` / `version` / `author`，`version` 用语义化版本；
   - 可选 `short_desc`（紧凑 UI 一句话）/ `social_link` / `tags`（市场分类与搜索）——都已填 ✅。

镜像仓库同时也能当「手动安装」入口：把整个目录拷进 `data/plugins/` 即可，
AstrBot 的插件管理页也支持直接填仓库地址安装。

### 发布页的等价人工路线（本仓库实际走的那条）

发布页本质就是往 [AstrBotDevs/AstrBot_Plugins_Collection](https://github.com/AstrBotDevs/AstrBot_Plugins_Collection)
的 `plugins.json` 追加一条（最新的几条 PR 都是这个形状），所以不用 Cloud 账号也能发：

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
