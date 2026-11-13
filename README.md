# 熄屏时间调度器

[English](README.en.md) · 简体中文

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)
![Electron](https://img.shields.io/badge/Electron-33.2.1-47848F)
![Node](https://img.shields.io/badge/Node.js-%E2%89%A518-339933)

按时段自动调整 Windows 屏幕熄屏超时的桌面小工具。锁屏时立即切换到独立策略，解锁后自动恢复，全程常驻系统托盘。

> 当前为 **2.0**，使用 Electron 全量重写（界面与后端均为新实现），取代早期的 Python / Tk 版本。

## 为什么需要它

Windows 的「关闭显示器」超时是全局设置，无法随作息变化：上班时希望屏幕多亮一会儿，午休或下班后希望尽快熄屏，锁屏后更该立刻关屏。本程序按 **锁屏 / 午休 / 上班 / 下班** 四种状态自动调用 `powercfg` 切换超时，不需要人工干预。

## 特性

- **锁屏拥有最高优先级**：会话一旦锁定，立即忽略所有时段规则
- **四套独立超时**：锁屏、午休、上班、下班分别配置，`0` 表示永不熄屏
- **现代界面**：自绘标题栏 + 左侧导航 + 状态总览 Hero 卡 + 分页设置 + 固定操作栏
- **实时状态**：首屏显示当前生效模式、大号熄屏分钟数，以及高亮的生效优先级链
- **锁屏通知**：锁屏 / 解锁时推送系统 Toast，自动跳过锁屏界面过渡期
- **屏幕占用检测**：解析 `powercfg /requests`，列出阻止熄屏的程序、驱动与服务，支持结束进程
- **托盘常驻 / 单实例 / 开机自启**
- **配置自动迁移**：首次运行自动读取 Python 旧版配置，无需重新设置

## 界面

| 区域 | 内容 |
|---|---|
| 左侧导航 | 状态总览、锁屏、午休、工作时段、屏幕占用；底部开机自启开关 |
| 顶部 Hero 卡 | 当前生效模式、熄屏倒计时分钟数、`锁屏 › 午休 › 上班 › 下班` 优先级链 |
| 内容区 | 按导航分页，每页只有 1~2 张卡片；滑块、数字输入、时间选择、开关 |
| 底部操作栏 | 隐藏到托盘、保存并应用（有未保存更改时提示） |

锁屏状态在导航里单独成页、带「最高」徽章，并在优先级链中排第一——层级关系由布局表达，而不是靠一行文字说明。

## 生效优先级

| 优先级 | 状态 | 判定条件 | 使用配置 |
|---|---|---|---|
| 1（最高） | 锁屏 | Windows 会话已锁定 | `lock_timeout` |
| 2 | 午休 | 已启用 **且** 落在上班时段内 **且** 落在午休窗口内 | `lunch_timeout` |
| 3 | 上班 | 落在上班时段内 | `work_timeout` |
| 4 | 下班 | 其余所有时间 | `off_timeout` |

午休必须同时落在「上班时段」和「午休窗口」内才生效，避免午休被误设在非工作时间后干扰下班策略。

## 快速开始

### 直接运行

下载仓库中的 `dist/ScreenTimeoutScheduler.exe`（Windows 10/11 x64 便携单文件，无需安装），双击即可。对应版本 tag 为 `v2.0.0`。

### 从源码运行

需要 Windows + Node.js 18 或更高版本。

```bash
npm install     # prepare 阶段会自动生成图标资产
npm start
```

### 打包

```bash
npm run dist
```

产物为 `dist/ScreenTimeoutScheduler.exe`（electron-builder portable）。

## 配置

配置文件位于 `%APPDATA%\screen-timeout-scheduler\config.json`，也可以直接在界面里修改后点「保存并应用」。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `work_start` | `09:00` | 上班开始 |
| `work_end` | `18:00` | 上班结束 |
| `work_timeout` | `30` | 上班熄屏超时（分钟） |
| `off_timeout` | `3` | 下班熄屏超时（分钟） |
| `lunch_enabled` | `true` | 是否启用午休时段 |
| `lunch_start` | `12:00` | 午休开始 |
| `lunch_end` | `13:00` | 午休结束 |
| `lunch_timeout` | `30` | 午休熄屏超时（分钟） |
| `lock_timeout` | `1` | 锁屏熄屏超时（分钟） |
| `notify_on_lock` | `true` | 锁屏 / 解锁时推送通知 |
| `auto_start` | `false` | 开机自启 |

所有超时值 `0` 均表示「永不熄屏」。首次运行时若检测到 Python 旧版配置
`%APPDATA%\ScreenTimeoutScheduler\config.json`，会自动迁移。

## 工作原理

- **时段调度**：每 20 秒检查一次；状态变化时立即执行 `powercfg /change monitor-timeout-ac|dc <分钟>`，同时设置交流电与电池两种模式。
- **锁屏检测**：主通道为 Electron `powerMonitor` 的 `lock-screen` / `unlock-screen` 事件，另有每 3 秒一次的 `LogonUI.exe` 轮询兜底，防止事件丢失。
- **通知**：使用 Electron `Notification`（WinRT Toast）。启动时写入注册表开启锁屏通知与锁屏内容显示（`AllowContentAboveLock`），并在锁屏后延迟 2 秒发送，避开 Windows 切换安全桌面的过渡期。
- **托盘与生命周期**：托盘图标按模式切换颜色；`app.requestSingleInstanceLock()` 保证单实例；`setLoginItemSettings` 管理开机自启；关闭窗口仅隐藏到托盘。
- **占用检测**：`powercfg /requests` 输出按 UTF-8 / GBK / cp437 依次尝试解码，解析出进程、驱动、服务条目；`tasklist` 按可执行文件名定位 PID，`taskkill` 结束进程，并禁止结束系统关键进程与程序自身。

## 目录结构

```
.
├── scripts/
│   └── gen-icons.js      # 生成托盘 PNG 与应用 ICO（纯 Node，无第三方依赖）
├── src/
│   ├── main.js           # 主进程：调度、锁屏检测、托盘、通知、IPC、占用检测
│   ├── preload.js        # contextBridge 安全桥接
│   ├── index.html        # 界面结构
│   ├── styles.css        # 样式与响应式布局
│   ├── renderer.js       # 交互与状态渲染
│   └── icons/            # 运行时生成的托盘图标（不入库）
├── build/icon.ico        # 运行时生成的打包图标（不入库）
├── dist/                 # 构建产物
├── package.json
└── package-lock.json
```

## 常见问题

**锁屏后没看到通知？**
Windows 锁屏界面需要 1~2 秒完成安全桌面切换，程序已延迟 2 秒发送；测试时请锁屏后停留 10 秒以上。如果卡片只显示「私密」，请检查系统设置里的「在锁屏界面隐藏通知内容」。

**为什么 exe 有 70 多 MB？**
Electron 便携单文件内置了 Chromium 运行时。该文件超过 GitHub 建议的 50 MB，后续构建更推荐放到 Releases 附件，而不是提交进 git 历史。

**clone 之后图标文件不见了？**
图标由 `scripts/gen-icons.js` 在 `npm install` 的 `prepare` 阶段生成，仓库只保存生成脚本以保证构建可复现。也可以手动执行 `npm run icons`。

## 已知限制

- 仅支持 Windows（依赖 `powercfg`、注册表与 Windows 通知机制）。
- 锁屏检测采用 Electron 事件 + LogonUI 兜底，与旧版 Python 的 `OpenInputDesktop` 方案不同，**尚未在真实 `Win+L` 场景下完整验证**。
- 只会修改当前电源计划的「关闭显示器」超时，不改动睡眠、休眠等其他电源设置。

## 仓库

https://github.com/whenjun/screen-timeout-scheduler
