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
   `version`（形如 `v0.2.1`）、`CHANGELOG.md` 新增版本小节。
2. 跑测试：`npm test`（纯函数单测）与 `npm pack --dry-run`（确认 tarball 内容）。
3. 推源码仓库：

   ```bash
   git add -A && git commit -m "1.2.3: ..." && git push
   ```

4. 同步镜像仓库：

   ```bash
   gh repo clone CCYellowStar2/astrbot_plugin_dsh /tmp/astrbot_plugin_dsh
   node scripts/sync-plugin-mirror.mjs /tmp/astrbot_plugin_dsh
   cd /tmp/astrbot_plugin_dsh && git add -A && git commit -m "v1.2.3" && git push
   ```

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

## AstrBot 插件市场（可选）

AstrBot 通过 `metadata.yaml` 的 `repo` / `name` 识别插件。想让别人一键装，把镜像仓库地址
提交到 AstrBot 的插件索引；用户也可以直接把整个目录拷进 `data/plugins/`。
