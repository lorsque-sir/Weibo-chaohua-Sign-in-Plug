# 微博超话一键签到（插件版） - 项目技术分析

本文档由 AI 助手分析生成，详细记录了本项目的架构设计、目录结构及核心实现原理。

---

## 1. 架构概述

本项目是一个基于 **Chrome Extension Manifest V3** 标准的纯前端浏览器插件，主要功能为一键自动巡检与签到已关注的微博超话（Super Topic），并支持每日定时自动签到、补签检测与统计分析。

- **无需后端服务器**：所有请求直接与微博官方移动端接口（`m.weibo.cn`）通信，Cookie 与配置仅保存在本地。
- **目标浏览器**：支持基于 Chromium 架构的 Chrome、Edge 等浏览器。

---

## 2. 目录结构与关键文件

```text
Weibo-chaohua-Sign-in-Plug/
├── README.md                      # 官方使用说明与 FAQ
├── PROJECT_ANALYSIS.md            # 项目架构与技术分析文档（本文件）
└── weibo-chaohua-checkin/         # 插件核心源码
    ├── manifest.json              # 插件配置文件 (Manifest V3)
    ├── background.js              # Service Worker 后台脚本（定时/补签/MAIN上下文注入）
    ├── popup.html                 # 插件弹窗 DOM 结构
    ├── popup.js                   # 插件弹窗交互逻辑（签到、分析、设置、日志与表格渲染）
    ├── preview.html               # 独立离线预览页面（模拟数据）
    └── styles.css                 # 界面样式
```

---

## 3. 核心功能与技术实现细节

### 3.1 跨域与 Cookie/Referer 绕过机制 (`MAIN` World Script Execution)
微博移动端 API 对 `Referer`、`Cookie` 以及 `Sec-Fetch-*` 等请求头具有严格校验。由于 MV3 Service Worker 或普通 Content Script 直接调用 `fetch()` 容易缺少必要 Header：

- **实现原理**：在 `background.js` 中使用 `chrome.scripting.executeScript`，并指定 `world: 'MAIN'`，使 Fetch 代码直接在目标微博标签页（`https://m.weibo.cn/*`）的主页面上下文（Main World）中执行。
- **自动标签页管理**：通过 `ensureWeiboTab()` 检测是否有打开的微博页面；若无，后台隐蔽创建一个 `https://m.weibo.cn/p/tabbar?containerid=100803_-_recentvisit` 标签页供脚本通信。

### 3.2 每日自动签到与智能补签 (`alarms` & `checkMakeup`)
- **定时调度**：利用 `chrome.alarms` 机制，依据用户配置的每日时间（如 `09:00`），将目标时间计算为本地毫秒数后创建闹钟。
- **补签功能**：解决由于设备休眠或浏览器未运行导致到点未执行的问题。在插件启动 (`chrome.runtime.onStartup`) 及首次安装 (`chrome.runtime.onInstalled`) 时触发 `checkMakeup()`。若发现当天尚未运行且时间已过，则自动补签一次。

### 3.3 状态分析与防刷重试
- **状态分析 (Analyze)**：只调用获取超话卡片接口，识别按钮为“签到”还是“已签到”，只做统计计算与表格渲染，不发起真实的签到 Scheme 请求。
- **重试与指数退避**：内置 `fetchWithRetry` 机制，当遭遇 `429`（Too Many Requests）或 `5xx` 错误时自动重试，并在遍历签到时追加 `300~600ms` 的随机延时。

### 3.4 离线预览模式 (Preview Mode)
- 在 [popup.js](file:///Users/cknight/ck/Programmar/Front/Weibo-chaohua-Sign-in-Plug/weibo-chaohua-checkin/popup.js) 中自动检测 `chrome.tabs` 环境。在非扩展环境下（直接双击打开 `preview.html`），自动切换至预览模式并提供模拟数据（Mock Data），极大方便前端 UI 修改与演示。

---

## 4. 权限与存储声明

| 权限名称 | 用途 |
|---|---|
| `storage` | 使用 `chrome.storage.local` 本地保存插件设置与上次运行统计 |
| `alarms` | 创建每日定时闹钟 |
| `scripting` | 向微博标签页的主世界 (`MAIN`) 动态注入 Fetch 执行脚本 |
| `tabs` | 查询及创建微博标签页 |
| `host_permissions` | 声明对 `https://m.weibo.cn/*` 与 `https://passport.weibo.com/*` 的网络访问权限 |
