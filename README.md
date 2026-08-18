# dsh-windows-desktop

DeepSeek Harness 的 Windows 桌面客户端 — 基于 Electron 封装 `dsh web`，双击运行，零配置。

## 原理

```
┌─────────────────────────────────┐
│  dsh-windows-desktop.exe        │
│  ┌───────────┐  ┌────────────┐  │
│  │ Main Proc  │  │BrowserWindow│  │
│  │ (Node.js)  │  │  loads URL  │  │
│  │   ↓ spawn  │  │ 127.0.0.1   │  │
│  │ dsh web    │←─┤  :<random>  │  │
│  │ (child)    │  │             │  │
│  └───────────┘  └────────────┘  │
│  + System Tray                  │
│  + API Key 加密存储              │
└─────────────────────────────────┘
```

Electron 主进程启动 `dsh web` 子进程（随机空闲端口），等待 HTTP 就绪后 BrowserWindow 加载该 URL。API Key 通过 Windows DPAPI 加密存储。

## 开发

### 前置要求

- Node.js `^22.19 || >=24`
- pnpm `>=11`
- Windows 10+（打包目标；macOS/Linux 可开发但无法打包 Windows `.exe`）

### 安装

```sh
git clone https://github.com/jijiayue03/dsh-windows-desktop.git
cd dsh-windows-desktop
pnpm install
```

### 运行

```sh
# 开发模式：编译 TypeScript + 启动 Electron
pnpm run dev

# 仅编译
pnpm run build

# 运行测试
pnpm test

# 测试覆盖率
pnpm test:coverage

# 类型检查
pnpm run lint
```

### 打包

```sh
# 生成 NSIS 安装包 + 便携版 .exe
pnpm run pack

# 仅便携版
pnpm run pack:portable

# 仅目录（不打包，用于调试）
pnpm run pack:dir
```

产出在 `build/out/` 目录下。

## 架构

| 模块 | 职责 |
|------|------|
| `electron/main.ts` | 主进程入口：编排 dsh 子进程、窗口、托盘、IPC |
| `electron/dsh-process.ts` | dsh 子进程管理：spawn、URL 解析、生命周期 |
| `electron/port.ts` | 空闲端口分配 |
| `electron/ready.ts` | HTTP 就绪探测 |
| `electron/api-key.ts` | API Key 加密存储（Electron safeStorage / Windows DPAPI） |
| `electron/tray.ts` | 系统托盘 |
| `electron/preload.ts` | 预加载脚本（contextBridge） |
| `electron/ipc-types.ts` | IPC 通道类型 |

## 测试

测试覆盖所有核心模块，使用 vitest + mock：

```sh
pnpm test              # 运行全部测试
pnpm test:coverage     # 生成覆盖率报告
```

| 测试文件 | 覆盖范围 |
|----------|----------|
| `tests/port.test.ts` | 空闲端口分配、可绑定验证、连续唯一性 |
| `tests/ready.test.ts` | HTTP 探测、超时、取消、非 200 轮询、默认参数 |
| `tests/dsh-process.test.ts` | 子进程启动参数、URL 解析、多 chunk、生命周期、信号取消 |
| `tests/api-key.test.ts` | 加密存储/读取/删除、持久化、降级、损坏恢复 |
| `tests/tray.test.ts` | 托盘创建、菜单项、点击切换、销毁 |
| `tests/ipc-types.test.ts` | IPC 通道常量、类型构造 |
| `tests/main.test.ts` | 集成场景：端口→进程→就绪链路、API Key 环境注入、失败场景 |

## 配置

### API Key

首次启动时，在 dsh web 的设置界面中填入 DeepSeek API Key。Key 会通过 Windows DPAPI 加密后存储在 `%APPDATA%/dsh-windows-desktop/config.json` 中，下次启动自动注入。

### 环境变量

| 变量 | 说明 |
|------|------|
| `DEEPSEEK_API_KEY` | 由 API Key 存储自动注入到 dsh 子进程 |
| `DEEPSEEK_BASE_URL` | 可选，自定义 API 端点 |

## License

[MIT](LICENSE)
