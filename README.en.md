# Screen Timeout Scheduler

[简体中文](README.md) · English

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)
![Electron](https://img.shields.io/badge/Electron-33.2.1-47848F)
![Node](https://img.shields.io/badge/Node.js-%E2%89%A518-339933)

A Windows desktop utility that automatically adjusts the display-off timeout based on the time of day. When the session is locked it immediately switches to a dedicated policy, then restores the previous one on unlock. Runs quietly in the system tray.

> This is **2.0**, a full rewrite in Electron (both UI and backend), replacing the earlier Python / Tk version.

## Why

Windows has a single global "Turn off the display" timeout that cannot follow your schedule: you may want a longer delay while working, a shorter one during lunch or after hours, and an immediate screen-off as soon as you lock the machine. This app switches the timeout automatically between **lock / lunch / work / off** states via `powercfg`.

## Features

- **Lock screen has the highest priority**: once the session is locked, all time-based rules are ignored
- **Four independent timeouts**: lock, lunch, work, and off-hours; `0` means never turn off
- **Modern UI**: custom title bar, sidebar navigation, status hero card, paged settings, fixed action bar
- **Live status**: the first screen shows the active mode, a large timeout number, and a highlighted priority chain
- **Lock notifications**: system toasts on lock / unlock, delayed past the lock-screen transition
- **Display request inspector**: parses `powercfg /requests`, lists processes / drivers / services preventing the display from turning off, and can terminate them
- **System tray / single instance / launch at login**
- **Automatic config migration**: imports settings from the legacy Python version on first run

## Interface

![Interface preview](docs/preview.png)

| Area | Contents |
|---|---|
| Sidebar | Status overview, lock, lunch, work hours, display requests; launch-at-login switch at the bottom |
| Hero card | Active mode, timeout in minutes, and the `Lock › Lunch › Work › Off` priority chain |
| Content | Paged by navigation, 1–2 cards per page; sliders, number inputs, time pickers, switches |
| Action bar | Hide to tray, Save and apply (with an unsaved-changes indicator) |

The lock state gets its own navigation page with a "highest" badge and sits first in the priority chain — hierarchy is expressed through layout rather than a line of explanatory text.

## Priority

| Priority | State | Condition | Setting |
|---|---|---|---|
| 1 (highest) | Lock | Windows session is locked | `lock_timeout` |
| 2 | Lunch | Enabled **and** inside work hours **and** inside the lunch window | `lunch_timeout` |
| 3 | Work | Inside work hours | `work_timeout` |
| 4 | Off | Any other time | `off_timeout` |

Lunch only applies when it falls inside both the work-hours window and the lunch window, so a lunch range accidentally placed outside working hours cannot interfere with the off-hours policy.

## Getting started

### Run the binary

Download `dist/ScreenTimeoutScheduler.exe` from this repository (portable single file for Windows 10/11 x64, no installation needed) and double-click it. It corresponds to tag `v2.0.0`.

### Run from source

Requires Windows and Node.js 18 or newer.

```bash
npm install     # the prepare step generates icon assets
npm start
```

### Build

```bash
npm run dist
```

Output: `dist/ScreenTimeoutScheduler.exe` (electron-builder portable).

## Configuration

Stored at `%APPDATA%\screen-timeout-scheduler\config.json`; you can also edit it in the UI and click "Save and apply".

| Key | Default | Description |
|---|---|---|
| `work_start` | `09:00` | Work start |
| `work_end` | `18:00` | Work end |
| `work_timeout` | `30` | Display-off timeout during work (minutes) |
| `off_timeout` | `3` | Display-off timeout off-hours (minutes) |
| `lunch_enabled` | `true` | Enable the lunch period |
| `lunch_start` | `12:00` | Lunch start |
| `lunch_end` | `13:00` | Lunch end |
| `lunch_timeout` | `30` | Display-off timeout during lunch (minutes) |
| `lock_timeout` | `1` | Display-off timeout while locked (minutes) |
| `notify_on_lock` | `true` | Notify on lock / unlock |
| `auto_start` | `false` | Launch at login |

A timeout of `0` means never turn off the display. On first run, a legacy Python config at
`%APPDATA%\ScreenTimeoutScheduler\config.json` is migrated automatically.

## How it works

- **Scheduling**: checks every 20 seconds; on state change runs `powercfg /change monitor-timeout-ac|dc <minutes>` for both AC and battery.
- **Lock detection**: primary channel is Electron `powerMonitor` `lock-screen` / `unlock-screen` events, with a `LogonUI.exe` poll every 3 seconds as a fallback against missed events.
- **Notifications**: Electron `Notification` (WinRT toast). On startup the app enables lock-screen notifications and lock-screen content in the registry (`AllowContentAboveLock`), then sends 2 seconds after locking to get past the secure-desktop transition.
- **Tray and lifecycle**: tray icon color follows the active mode; `app.requestSingleInstanceLock()` enforces a single instance; `setLoginItemSettings` manages launch at login; closing the window only hides it to the tray.
- **Display requests**: `powercfg /requests` output is decoded with UTF-8 / GBK / cp437 fallbacks and parsed into process, driver, and service entries; `tasklist` resolves PIDs by executable name and `taskkill` terminates them, with safeguards against system-critical processes and the app itself.

## Project layout

```
.
├── docs/
│   └── preview.png       # UI screenshot
├── scripts/
│   └── gen-icons.js      # Generates tray PNGs and the app ICO (pure Node, no deps)
├── src/
│   ├── main.js           # Main process: scheduling, lock detection, tray, notifications, IPC
│   ├── preload.js        # contextBridge security layer
│   ├── index.html        # UI structure
│   ├── styles.css        # Styles and responsive layout
│   ├── renderer.js       # Interactions and state rendering
│   └── icons/            # Generated tray icons (not committed)
├── build/icon.ico        # Generated build icon (not committed)
├── dist/                 # Build artifacts
├── package.json
└── package-lock.json
```

## FAQ

**I don't see a notification after locking.**
Windows needs 1–2 seconds to switch to the secure desktop; the app already waits 2 seconds. When testing, stay on the lock screen for at least 10 seconds. If the card only says "Private", check the system setting that hides notification content on the lock screen.

**Why is the exe over 70 MB?**
The portable Electron binary bundles the Chromium runtime. It exceeds GitHub's recommended 50 MB, so future builds should be published as Release assets instead of committed to git history.

**Icons are missing after cloning.**
They are generated by `scripts/gen-icons.js` during the `prepare` step of `npm install`; only the generator is committed so builds stay reproducible. You can also run `npm run icons` manually.

## Limitations

- Windows only (depends on `powercfg`, the registry, and Windows notifications).
- Lock detection uses Electron events plus a LogonUI fallback, which differs from the legacy Python `OpenInputDesktop` approach and **has not yet been fully verified against a real `Win+L` session**.
- Only the active power plan's display-off timeout is modified; sleep, hibernation, and other power settings are untouched.

## Repository

https://github.com/whenjun/screen-timeout-scheduler
