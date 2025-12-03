# GeekEZ Browser

<div align="center">

<img src="icon.png" width="100" height="100" alt="GeekEZ Logo">

[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc-sa/4.0/)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Version](https://img.shields.io/badge/version-1.2.1-green)

**专为电商运营和多账号管理打造的指纹隐匿浏览器**

[🇺🇸 English](README.md) | [📥 下载安装包](https://github.com/EchoHS/GeekezBrowser/releases)

</div>

---

## 📖 简介

**GeekEZ Browser** 是一款基于 **Electron** 和 **Puppeteer** 构建的指纹浏览器，底层深度集成 **Xray-core**。

它致力于解决跨境电商（TikTok, Amazon, Facebook, Shopee 等）的多账号防关联问题。与市面上的普通工具不同，GeekEZ 采用了 **“原生一致性”** 策略，摒弃了容易被检测的 JS 注入 Hook，从而完美通过 Cloudflare 和 BrowserScan 的高强度检测。

## ✨ 核心特性 (v1.2.1)

### 🛡️ 深度指纹隔离
*   **原生参数注入**: 放弃了易被检测的 JS Hook (`Object.defineProperty`)，改用 Chromium **原生启动参数**修改 UserAgent 和语言，彻底消除 JS 篡改痕迹，完美通过 **Cloudflare Turnstile**。
*   **本地扩展 (Extension) 注入**: 通过动态生成的本地插件注入 Canvas 和 Audio 噪音，确保代码运行在 Content Script 隔离域，进一步降低被检测风险。
*   **硬件一致性**: 严格匹配宿主机系统（Windows/Mac）生成对应指纹，杜绝“在 Windows 上跑出 Mac M1 指纹”的逻辑漏洞。
*   **时区智能伪装**: 内置 120+ 全球主流机房时区，支持搜索选择。通过劫持底层时间 API，使浏览器时间与代理 IP 所在地完美同步。
*   **WebRTC 物理阻断**: 强制使用 `disable_non_proxied_udp` 策略，物理切断本地 IP 泄露路径。

### 🔗 全能网络引擎 (Xray-core)
*   **全协议支持**: 完美支持 VMess, VLESS, Trojan, Shadowsocks (含 **SS-2022**), Socks5, HTTP。
*   **高级传输层**: 支持 **REALITY**, **XHTTP**, **gRPC**, **mKCP**, WebSocket, H2 等复杂传输配置。
*   **前置代理 (链式代理)**: 支持 `[本机] -> [前置代理] -> [环境代理] -> [目标网站]` 架构。
*   **双栈支持**: 智能路由策略，完美支持 IPv4/IPv6 双栈节点。

### 🧩 工作流与管理
*   **插件支持**: 支持导入解压后的 Chrome 扩展（如 MetaMask, AdBlock），并自动应用到所有环境。
*   **标签系统**: 为环境添加彩色标签（如 "TikTok", "美国", "主号"），便于分组管理。
*   **安全备注**: 创新性地使用 **书签栏** 显示环境名称（如 `🔍 Profile-1`），替代了易被风控检测的标题栏注入。
*   **稳定多开**: 修复了端口冲突问题，支持同时运行多个环境互不干扰。

## 🚀 快速开始

### 方法 1: 下载安装包 (推荐)
前往 [**Releases**](https://github.com/EchoHS/GeekezBrowser/releases) 页面下载适配您系统的安装包：
*   **Windows**: `GeekEZ.Browser.Setup.1.2.1.exe`

### 方法 2: 源码运行

**前置要求**: 安装 Node.js (v16+) 和 Git。

1.  **克隆仓库**
    ```bash
    git clone https://github.com/EchoHS/GeekezBrowser.git
    cd GeekezBrowser
    ```

2.  **安装依赖**
    *推荐使用国内镜像源*
    ```bash
    npm install
    ```
    *注意：安装过程中会自动触发 `setup.js` 脚本，智能检测您的网络环境（中国/海外），自动下载 Xray 内核和 Chrome 浏览器（国内自动使用加速镜像）。*

3.  **启动软件**
    ```bash
    npm start
    ```

## 🛠 平台适用性指南

| 平台 | 安全评级 | 备注建议 |
| :--- | :--- | :--- |
| **TikTok** | ✅ 安全 | Canvas 噪音有效防止设备关联。核心在于使用高质量的纯净住宅 IP。 |
| **Facebook** | ✅ 安全 | 已彻底去除 WebDriver 和 Automation 特征。适合广告投放和日常养号。 |
| **Shopee** | ✅ 安全 | 指纹稳定，适合卖家后台运营。 |
| **Amazon (买家)** | ✅ 安全 | 隔离级别足以应对买家号、测评号的风控。 |
| **Amazon (卖家)** | ⚠️ 谨慎 | 对于资金巨大的主店铺，由于 Electron 固有的 TLS 指纹特征，建议仍使用物理隔离 (VPS) 以策万全。 |
| **Cloudflare** | ✅ 通过 | 采用原生注入策略，无 JS Hook 痕迹，轻松绕过人机验证。 |

## 📦 打包发布

如果您需要自己生成安装包：

```bash
# Windows
npm run build:win
```

```bash
# macOS
npm run build:mac
```
```bash
# Linux
npm run build:linux
```

## ⚠️ 免责声明
本软件仅供技术研究与教育使用。开发者不对因使用本软件导致的账号封禁、法律风险或经济损失承担任何责任。请用户严格遵守各平台的使用规则和当地法律法规。
