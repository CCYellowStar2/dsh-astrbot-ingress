---
name: dsh-qq-send-file
description: "Send a workspace file back to QQ via the AstrBot DSH bridge. Use when the user asks to 发到QQ / 发给我 / 发过来 / 发到群 / send this file, or when a generated patch/report/log should be delivered as a chat attachment instead of only a path. Do not use for ordinary text replies."
---

# QQ 出站发文件

当前会话若经 AstrBot `/dsh` 接到 QQ，要把**已经写在工作区内的文件**发回聊天窗口时，不要只报路径，在助手回复里写一行：

```
[SEND_FILE: <工作区内已存在的绝对路径>]
```

ingress 会剥掉这一行，把文件拷到协议端能读的目录再发给 QQ。

## 何时用

- 用户说「发过来」「发到 QQ」「把这个文件发给我」
- 你刚生成了补丁、日志、报表、txt，对方需要在手机上打开
- 不要把这一整段协议复述给用户

## 规则

- 路径必须是**当前工作区里已存在的文件**（Windows 如 `D:\dswk\hello.txt`）
- 不要发工作区外、`.ssh` / `.env` / 密钥类路径
- 单文件约 12MB 以内；一次最多 4 个
- 这一行可以和普通文字一起出现；文字会发到 QQ，标记本身不会

## 不要

- 不要编造还不存在的路径（先写入再 SEND_FILE）
- 不要用 URL、`file://`、相对路径碰运气；给绝对路径
- 用户只是问内容、没要求发文件时，不要主动发

## 手动兜底

用户也可以自己发：`/dsh send <绝对路径>`（不经过模型）。
