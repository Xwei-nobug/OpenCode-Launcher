# opencode 启动器 · 桌面端

Electron 桌面应用源码。产品介绍与安装方式见 [根 README](../README.md)。

## 结构

```
main.js       主进程：窗口、单实例、IPC、原生对话框
preload.js    渲染层与主进程之间的白名单通道
core/core.js  后端：配置、opencode 定位与安装、启动、关闭、会话、缓存、日志
renderer/     界面：index.html / style.css / app.js（无框架）
build/        应用图标（打包时自动转换）
test/         后端测试、端到端测试、图标生成脚本
```

## 开发

```bash
npm install
npm start              # 开发运行
npm run test:backend   # 后端测试
npm run test:ui        # 端到端测试（真实窗口，支持 LAUNCHER_EXE=<exe> 驱动安装版）
npm run dist           # 打包安装包 -> dist/
```

## 许可

[MIT](../LICENSE)
