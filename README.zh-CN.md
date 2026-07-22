# HelixUI

[English](README.md)

HelixUI 是一个面向本地 AI 编程代理的响应式网页界面，支持 Claude Code、
OpenAI Codex、Cursor CLI、Gemini CLI 和 OpenAI 兼容的自定义服务。它包含流式
对话、可重连 Shell/Terminal、文件与 Git 工具、会话整理、语音转文字和用量面板。

## 安全边界

服务器会以启动它的系统账号权限执行终端命令。默认只监听
`127.0.0.1`；对外提供服务前必须配置 HTTPS 反向代理、身份认证和防火墙。
网页账号不能替代操作系统沙箱，不互相信任的用户应使用独立容器、虚拟机或独立
实例。部署前请阅读 [SECURITY.md](SECURITY.md)。

## 从源码安装

需要 Node.js 22 或更高版本，并至少安装、登录一个受支持的代理 CLI。

```bash
git clone https://github.com/StewartJohn0/helixui.git
cd helixui
npm ci --include=dev
cp .env.example .env
npm run build
npm run server
```

打开 `http://127.0.0.1:3001`。空数据库中创建的第一个账号是管理员；创建后公开
注册立即关闭。运行数据默认保存在 `~/.cloudcli`，工作区默认限制在
`~/CloudCLIWorkspaces`。

## 配置与验证

完整配置见 [.env.example](.env.example)，网络部署见
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。提交或发布前执行：

```bash
npm run verify
```

该命令会检查秘密与私有部署信息、运行稳定性和安全边界测试、TypeScript 类型检查
以及生产构建。

维护者发布前应运行更完整的 `npm run release:check`；它还会从 tarball 进行全新安装、
启动服务验证数据目录隔离，并审计下载者实际获得的生产依赖。

## 发布与许可

版本使用语义化 Git 标签和 GitHub Release 管理，流程见
[docs/RELEASING.md](docs/RELEASING.md)。项目基于
[siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)，按照
[AGPL-3.0-or-later](LICENSE) 发布。
