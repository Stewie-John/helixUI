<div align="center">
  <img src="public/logo.svg" alt="HelixUI" width="72" height="72">
  <h1>HelixUI</h1>
  <p>面向 AI 编程代理的自托管网页工作区。</p>
</div>

<p align="center">
  <a href="https://github.com/StewartJohn0/helixui/actions/workflows/ci.yml"><img src="https://github.com/StewartJohn0/helixui/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@stewiejohn/helix-ui"><img src="https://img.shields.io/npm/v/@stewiejohn/helix-ui" alt="npm 版本"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D22-339933" alt="Node.js 22 或更高版本"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="AGPL-3.0-or-later"></a>
  <a href="./README.md">English</a>
</p>

HelixUI 将 Claude Code、OpenAI Codex、Cursor CLI、Gemini CLI 和兼容的自定义
服务整合到一个响应式浏览器工作区中。它面向希望保留终端级代理工作流，同时需要
持久会话、文件、Git、用量统计和跨设备访问的用户。

## 主要能力

- **持久代理对话**：流式输出、断线恢复、后续消息排队、会话整理、上下文用量和
  Goal 历史。
- **真实 Shell 与 Terminal**：基于 PTY，支持重连和同一会话内延续。
- **工作区工具**：文件浏览、模糊搜索、拖放、编辑、Diff、Git 和项目导航。
- **多代理接入**：Claude Code、OpenAI Codex、Cursor、Gemini 以及
  OpenAI 兼容接口。
- **运行状态面板**：额度、Token、账号用量、系统资源和当前工作状态。
- **完整交互体验**：桌面与移动端布局、多语言、语音转文字、三套外观和 PWA。
- **发布安全门禁**：隐私扫描、路径边界、WebSocket 来源、认证边界、全新安装和
  生产依赖审计。

## 环境要求

- Node.js 22 或更高版本
- Linux 或 macOS；完整 PTY 功能需要类 Unix 系统
- 至少安装并登录一个受支持的代理 CLI

## 快速开始

### 从 npm 安装

```bash
npm install -g @stewiejohn/helix-ui
helix-ui
```

### 从源码安装

```bash
git clone https://github.com/StewartJohn0/helixui.git
cd helixui
npm ci --include=dev
cp .env.example .env
npm run build
npm run server
```

打开 `http://127.0.0.1:3001`。空数据库中创建的第一个账号会成为管理员，
随后公开注册立即关闭。运行数据默认保存在源码目录之外的 `~/.cloudcli`，
工作区默认限制在 `~/CloudCLIWorkspaces`。

## 支持的代理

只需安装并登录准备使用的工具：

| 服务 | 本机依赖 |
| --- | --- |
| Claude | Claude Code CLI |
| OpenAI | Codex CLI |
| Cursor | Cursor CLI |
| Google | Gemini CLI |
| 兼容 API | 服务地址与 API Key |

代理凭据和会话保留在运行 HelixUI 的机器上。

## 安全边界

HelixUI 会以启动它的系统账号权限执行命令。除非服务受到 HTTPS 反向代理、身份
认证和防火墙保护，否则应保持默认的本机监听。网页账号不能替代操作系统沙箱；
互不信任的用户必须使用不同容器、虚拟机、Unix 账号或独立 HelixUI 实例。

任何网络部署前都应阅读 [安全策略](SECURITY.md) 和
[公网部署指南](docs/PUBLIC_DEPLOYMENT.md)。

常用生产配置包括：

```env
HOST=127.0.0.1
PORT=3001
WORKSPACES_ROOT=/独立工作区的绝对路径
CLOUDCLI_DATA_DIR=/持久化私有数据的绝对路径
ALLOWED_HOSTS=helix.example.com
CORS_ORIGIN=https://helix.example.com
WS_ALLOWED_ORIGINS=https://helix.example.com
JWT_SECRET=替换为64位随机十六进制字符串
CREDENTIALS_ENCRYPTION_KEY=替换为另一段64位随机十六进制字符串
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [.env.example](.env.example) | 配置说明与安全默认值 |
| [部署指南](docs/DEPLOYMENT.md) | 本机和反向代理部署 |
| [公网部署](docs/PUBLIC_DEPLOYMENT.md) | 公网威胁模型与加固 |
| [安全策略](SECURITY.md) | 信任边界和漏洞报告 |
| [支持说明](SUPPORT.md) | 安全提交 Bug 和诊断信息 |
| [参与贡献](CONTRIBUTING.md) | 开发和 Pull Request 流程 |
| [版本规则](docs/VERSIONING.md) | 独立的 `YYYY.M.PATCH` 版本体系 |
| [发布流程](docs/RELEASING.md) | GitHub 与 npm 维护者流程 |

## 开发与验证

```bash
npm ci --include=dev
npm run dev
```

提交前执行：

```bash
npm run verify
```

维护者发布前执行 `npm run release:check`。它会扫描私有部署信息和秘密，运行稳定性
与安全边界测试，完成类型检查和生产构建，在全新 HOME 下安装并启动 npm 包验证
运行数据隔离，最后审计用户实际获得的生产依赖。

## 版本与来源

HelixUI 使用 `2026.7.0` 这类日历版本，与上游项目的版本序列完全独立。历史 npm
版本 `1.23.0` 仅是兼容阶段版本，详见 [版本规则](docs/VERSIONING.md)。

本项目基于 [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)
开发，保留并感谢上游提供的原始服务器架构、会话管理和多代理集成框架。

## 许可证

项目按照 [AGPL-3.0-or-later](LICENSE) 发布。通过网络向用户提供服务时，必须按
许可证要求向用户提供对应源代码。
