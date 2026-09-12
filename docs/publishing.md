# 发布步骤（两个仓库 + npm）

本仓库是**唯一源码**：DSH 侧插件在根目录，AstrBot 插件在 `astrbot_plugin_dsh/`。
AstrBot 插件另有一个**镜像仓库**（内容一样），用脚本同步过去。

先按实际情况替换这些占位符：

| 占位符 | 用在哪儿 |
|---|---|
| `<AUTHOR>` | `LICENSE`、`package.json` 的 `author`、`metadata.yaml` 的 `author` |
| `<GITHUB_USER>` | 两个仓库的归属（用户名或组织） |
| `<INGRESS_REPO>` | 本仓库名，默认 `dsh-astrbot-ingress` |
| `<PLUGIN_REPO>` | 插件镜像仓库名，默认 `astrbot_plugin_dsh` |

## 一次性的元数据

1. `package.json` 补上：

   ```json
   "author": "<AUTHOR>",
   "repository": { "type": "git", "url": "git+https://github.com/<GITHUB_USER>/<INGRESS_REPO>.git" },
   "homepage": "https://github.com/<GITHUB_USER>/<INGRESS_REPO>#readme",
   "bugs": { "url": "https://github.com/<GITHUB_USER>/<INGRESS_REPO>/issues" }
   ```

2. `astrbot_plugin_dsh/metadata.yaml` 把 `author` 改成 `<AUTHOR>`、`repo` 填插件仓库地址
   `https://github.com/<GITHUB_USER>/<PLUGIN_REPO>`（AstrBot 插件市场靠这个字段找仓库）。

3. README 互相链接改成**绝对 URL**（npm 页面不解析相对路径）：
   - 根 README 里指向 `astrbot_plugin_dsh/README.md` 的链接 → 插件仓库地址
   - 插件 README 里指向 `../README.md` 的链接 → 本仓库地址

## 发布 DSH 侧插件（npm）

```bash
npm test                     # 13 个纯函数单测
npm pack --dry-run           # 看清 tarball 里有什么（lib/ skills/ astrbot_plugin_dsh/ docs/ test/）
npm publish --access public  # 需要先 npm login；包名 dsh-astrbot-ingress 目前未被占用
```

发完在 npm 页面确认 README 渲染正常（尤其表格与代码块）。

## 发布两个 GitHub 仓库

```bash
# 仓库 A：DSH 侧插件（当前目录）
git init && git add -A && git commit -m "dsh-astrbot-ingress 0.2.0"
git branch -M main
git remote add origin https://github.com/<GITHUB_USER>/<INGRESS_REPO>.git
git push -u origin main

# 仓库 B：AstrBot 插件镜像
cd /path/to/empty/<PLUGIN_REPO>        # 先建空仓库并 clone
node /path/to/dsh-astrbot-ingress/scripts/sync-plugin-mirror.mjs .
git add -A && git commit -m "astrbot_plugin_dsh 0.2.0（镜像自 <INGRESS_REPO>）"
git push -u origin main
```

改完插件代码后：**先改本仓库的 `astrbot_plugin_dsh/`，再跑一次同步脚本**，两个仓库就不会漂。

## 版本一致性

三处必须同时改：`package.json` 的 `version`、`astrbot_plugin_dsh/metadata.yaml` 的 `version`
（形如 `v0.2.0`）、以及 `CHANGELOG.md` 的版本小节。

## AstrBot 插件市场（可选）

AstrBot 通过 `metadata.yaml` 的 `repo`/`name` 识别插件。想让别人一键装，把插件仓库地址
提交到 AstrBot 的插件索引（或直接分享仓库链接，用户也可以把整个目录拷进 `data/plugins/`）。
