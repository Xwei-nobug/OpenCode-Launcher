## opencode 启动器 v1.0.5

给 opencode 一个像样的桌面入口。选项目、管会话、一键启动与关闭、维护 opencode 本体——不用记命令，不用开一堆终端。

### 本次提供两个版本

| 资产 | 说明 | 大小 |
|---|---|---|
| `opencode-launcher-light-setup.exe` | **轻量版安装器（推荐）** — Tauri 2 + 系统 WebView2 | ~1.7 MB |
| `opencode-launcher-light.exe` | 轻量版免安装单文件，绿色运行 | ~4.5 MB |
| `opencode-launcher-setup-1.0.5.exe` | 桌面版安装器（Electron 38，自带 Chromium） | ~82 MB |

两个版本功能一致，轻量版体积小一个数量级；需要更独立的窗口环境时用桌面版。

### 功能

- **项目**：一键打开项目文件夹，或直接在项目目录启动；最近项目库；自动识别 Git 仓库（分支、领先 / 落后、改动统计）
- **会话**：展开项目查看全部会话（标题 / 消息数 / 更新时间 / 模型）；**单选会话后启动即续接**，不选则开启新会话；支持重命名与删除，双击直接续接
- **启动与关闭**：每个会话在独立、可见的终端窗口中启动（Windows Terminal / 命令提示符 / PowerShell）；「关闭 opencode」一键结束所有 opencode 进程，连同终端窗口一并关闭
- **维护**：版本查看、安装 / 修复、更新到最新版、卸载；缓存占用分类清理；环境自检；应用内卸载

### 安装

1. 下载 `opencode-launcher-light-setup.exe`（轻量版）或 `opencode-launcher-setup-1.0.5.exe`（桌面版）
2. 双击运行，选择安装位置（支持自定义），下一步完成
3. 打开后添加一个项目目录，点「启动项目」即可

> 安装包自带运行环境，无需预先安装 Node.js。首次使用若提示未安装 opencode，点「安装 / 修复」即可。

### 从源码构建

- 桌面版：`cd desktop && npm install && npm run dist`
- 轻量版：需要 Rust stable + MSVC 构建工具，`cd tauri && npm install && npm run dist`
