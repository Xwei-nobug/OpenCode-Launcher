# opencode 启动器

[opencode](https://opencode.ai) 的 Windows 桌面入口:管理项目、续接历史会话、一键在终端或内置 Web 界面里启动 opencode,并负责 opencode 本体的安装、更新与日常维护。

![界面预览](docs/screenshot.png)

## 这是什么

opencode 是终端里的 AI 编程助手,裸用有几个日常麻烦:

- 想续接之前的对话,得先想起来是在哪个目录、跑的哪次会话;
- 每次都要先 cd 到项目目录再敲命令;
- Web 界面好用,但要先起服务、开浏览器、过一遍登录,而且它的工作区面板和终端的项目列表互不相通;
- 升级、清缓存这类事没有现成入口。

启动器把这些收进一个窗口:左边是项目库,展开项目就能看到它名下的全部会话,选中任意一条再启动就是续接;顶部按钮直接打开内置 Web 界面;维护页负责 opencode 的安装、更新、卸载和缓存清理。

目前只提供 Windows 10/11 安装包。

## 功能

### 项目与会话

- 项目库管理常用目录,显示 Git 状态(分支、领先/落后、改动文件数),可一键打开文件夹。
- 展开项目即列出该目录下的全部会话:标题、消息数、更新时间、所用模型。选中一条后「终端打开」即续接该会话,不选则新开。
- 「全部记录」视图列出 opencode 里的所有项目与会话,包括没加入项目库的目录,支持搜索、重命名、删除,也可一键加入项目库。
- 开机自动定位「最近项目」:按哪个项目的会话最近有更新判定,其次按项目添加时间,和最后一次点击的是哪个无关。

### 启动方式

- **终端打开**:在独立的终端窗口(Windows Terminal / cmd / PowerShell,可选)中进入项目目录并启动 opencode,不占用现有终端,可附加启动参数。
- **启动 OpenCode Web**:Web 界面直接嵌在启动器窗口里,自动完成服务启动和登录配对,并把项目库对齐到 Web 的工作区面板;窗口关闭即释放内存,再次点击复用同一窗口。

### 项目库同步

启动器与 opencode 双向对齐:在启动器里增删项目,Web 端和终端随之更新;在 Web 或终端里新建的项目,启动器启动或点「刷新」时自动收进项目库。在别处删掉的项目也会从库里移除。删除项目会一并删除它在 opencode 里的记录和会话,**磁盘文件不受影响**,操作前有确认。

### 维护

- 查看 opencode 已安装版本与最新版本;安装 / 修复、更新、卸载(有 npm 走 npm,没有则直接下载官方独立包,全程不需要预装 Node.js)。
- 缓存占用分类统计与清理。
- 环境自检:opencode 位置、npm、终端、数据库、服务接口逐项检查。

### 自动更新(仅轻量版)

- 启动时后台查一次 GitHub 最新版本(24 小时内不重复联网),有新版会在「设置 → 关于」提示。
- 也可随时点「检查更新」。下载后校验文件大小和格式,确认后弹出安装向导,启动器自动退出让位,向导完成后即升级完毕。
- 桌面版不带此功能,仍需手动下载安装包覆盖。

## 两个版本

| | 轻量版(Tauri) | 桌面版(Electron) |
|---|---|---|
| 安装包 | ~1.8 MB | ~83 MB |
| 渲染内核 | 系统 WebView2(Win10/11 一般自带) | 内置 Chromium |
| 自动更新 | 有 | 无 |
| 状态 | **主力维护,推荐** | 功能相同,不再积极更新 |

两者功能一致。内置 Web 窗口打开期间的额外内存:桌面版约 +166 MB,轻量版约 +234 MB,关闭即释放——长时间挂 Web 界面可以选桌面版,其余场景轻量版都够用。

## 安装

从 [Releases](https://github.com/Xwei-nobug/OpenCode-Launcher/releases) 下载:

| 资产 | 说明 |
|---|---|
| `opencode-launcher-light-setup.exe` | 轻量版,推荐 |
| `opencode-launcher-setup-x.y.z.exe` | 桌面版 |

双击运行,按提示完成即可,无需预装 Node.js 或其他依赖。首次打开若提示未安装 opencode,到「维护」页点「安装 / 修复」即可。

## 数据存放

| 数据 | 位置 |
|---|---|
| 项目库、偏好、日志 | `%APPDATA%\opencode-launcher\` |
| opencode 的会话与项目 | `~/.local/share/opencode/opencode.db`(SQLite) |

关闭启动器窗口只退出界面,正在运行的 opencode 会话不受影响;需要结束它们时用顶部的「关闭 opencode」。

## 常见问题

**Web 工作区为什么不显示我的项目?**
该面板读的是浏览器 localStorage,和「设置 → 项目」的服务端数据不是一回事。用启动器的内置窗口打开会自动对齐;普通浏览器打开则写不进去。

**删除项目会删掉磁盘文件吗?**
不会。删的只是 opencode 里的项目记录及其会话。

**列表里偶尔多出一个没添加过的项目?**
opencode 启动后台服务时会把工作目录登记为项目。启动器会过滤用户主目录、临时目录和盘符根目录,这类记录不会显示。

**支持 macOS / Linux 吗?**
目前只有 Windows 安装包。

## 开发

### 轻量版(Tauri,主力)

需要 Rust stable 和 MSVC 构建工具(Visual Studio Build Tools 的 C++ 工作负载)。

```bash
cd tauri
npm install
npm run dev                     # 开发运行
npm run dist                    # 打包 -> tauri/dist/
node test/full-test.mjs         # 功能测试(Playwright + mock IPC)
node test/session-pick-test.mjs # 会话选择交互测试
cd src-tauri && cargo test      # 后端单元测试
```

前端在 `tauri/renderer/`(与桌面版同源,由 `bridge.js` 把 IPC 通道映射为 Tauri 命令),Rust 后端在 `tauri/src-tauri/src/`(`core.rs` 业务逻辑,`main.rs` 命令层)。

### 桌面版(Electron)

```bash
cd desktop
npm install
npm start              # 开发运行
npm run test:backend   # 后端测试
npm run test:ui        # Playwright 端到端测试
npm run dist           # 打包 -> desktop/dist/
```

### 发布

```bash
node scripts/publish-release.mjs v1.1.2 --notes docs/release-notes-v1.1.2.md \
  tauri/dist/opencode-launcher-setup.exe:opencode-launcher-light-setup.exe
```

Token 由本机 git 凭据管理器提供,同名资产会被替换,脚本可重复执行。`node scripts/list-releases.mjs` 列出各版本及资产。

注意:打包路径需为纯 ASCII 且不含空格,否则 NSIS 可能报错或产出异常安装包。

## 许可

[MIT](LICENSE)
