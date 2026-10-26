<div align="center">
  
# 🚀 DS Enhance Max (全能满血版)

**突破原生限制！为 DeepSeek 注入灵魂的高阶增强套件**

[![Version](https://img.shields.io/badge/version-v8.0.8-blue.svg?style=for-the-badge&logo=github)](#)
[![License](https://img.shields.io/badge/license-MIT-green.svg?style=for-the-badge)](#)
[![Platform](https://img.shields.io/badge/platform-Tampermonkey-orange.svg?style=for-the-badge&logo=tampermonkey)](#)

[⬇️ 点击安装脚本](#-快速安装) • [✨ 核心功能](#-核心卖点-core-features) • [🐛 提交反馈](https://github.com/TRYuuu233/DS-Enhance-Max/issues)

</div>

## 💡 诞生背景
当你每天与 DeepSeek 进行成百上千次高频对话时，你一定会遇到这些痛点：**历史会话堆积如山无法搜索**、**找不到以前的优秀对话**、**手动清理垃圾会话按到手酸**。

**DS Enhance Max** 就是为了终结这一切而生！这不仅仅是一个脚本，它是你专属的 **AI 对话资产管理神经中枢**。我们通过原生级的无缝注入，为你提供隔离级批量管理、AI 智能打标签、跨多模型引擎无缝切换等史诗级特性。

---

## 🔥 核心卖点 (Core Features)

### 🧠 1. 多模型神经中枢 (AI Hub)
突破单一模型束缚，在 DeepSeek 原生界面内**自由配置并无缝切换**全球顶尖大模型 API：
- 支持 **DeepSeek (官方/硅基流动/百炼)**、**OpenAI (GPT-4o)**、**Claude 3.5**、**Gemini 1.5 Pro**、**Kimi** 等。
- 无论你想用什么模型辅助整理对话，一键连通，所见即所得。

### 🏷️ 2. AI 自动化分类与智能标签
依靠大语言模型强大的语义分析能力，自动提取未归类对话的深层特征。
- **🎮 动态渲染引擎**：加载过程自带 3A 游戏级平滑进度条与动态神经突触文本，告别枯燥等待。
- **✨ 智能排他单选**：全局全选状态下，轻点任意彩色标签，瞬间独占过滤该标签下的所有会话，极速定位目标资产。

### 🔍 3. 语义级精准搜索
还在为找不到三个月前的一段优质代码发愁？
结合 AI 推理、实时标签与全文特征，在海量历史对话中实现**“百步穿杨”**级别的精准搜索提取。

### 📦 4. 原生隔离级批量管理
- **🗑️ 极速批量毁灭**：无惧官网页面重构，独立的底层 DOM 解析及错误容灾机制，一键批量秒删几百条废弃对话。
- **💾 批量导出备份**：勾选关键资产一键打包导出，支持数据防丢防崩。
- **🛡️ 弹性防爆容器**：即使你创建了成百上千个标签，自适应收缩的侧边栏也能保证你的核心对话视野绝对纯净。

### ⚙️ 5. 自定义系统提示词 (Prompt Injection)
一键注入原生 UI，自由开关定制化的人设指令，打造只属于你的完美 AI 人格。

---

## 📅 更新日志 (Changelog)

### v8.0.8 — 稳定性与兼容性专项（最新，基于 v8.0.7 基线）
> 感谢用户「曙光」反馈「批量删除后控制台无法关闭」的问题。

本次更新不涉及数据结构变更，既有的标签、提示词与模型配置均完整保留，覆盖安装即可。

- **修复**：批量删除后「关闭控制台」按钮被锁定、需刷新页面才能恢复的问题；异常分支现可正确释放界面锁。
- **加固**：启动链路全面故障隔离，原生 Fetch/XHR 拦截、本地存储与路由钩子中任一环节异常，均不再中断整体加载。
- **重构**：入口优先挂载，不再依赖页面渲染时序；控制台构建异常时入口自动转为告警态，可查看自检报告并一键重试。
- **新增**：入口自愈机制，按钮被移除、遮挡或样式隐藏时自动重建，兼容 SPA 路由切换。
- **修复**：AI 语义检索超时定时器泄漏，避免其误中断后续检索请求。
- **适配**：会话抓取增加多策略适配层，侧栏结构调整后同步依然有效。
- **适配**：内嵌「系统指令」入口改为多关键词与结构双重定位，兼容官方「联网搜索」更名为「智能搜索」。
- **优化**：提示词读取异常防护、悬浮入口位置越界校正，并支持 `Alt + Shift + D` 直接唤起控制台。

> 更新后在 DeepSeek 页面强制刷新一次（`Ctrl + F5`）即可生效；脚本头部 `@version` 应为 `8.0.8`。若入口未出现，可在控制台执行 `__dsDiag.check()` 查看自检报告。

---

## ⚡ 快速安装 (Installation)

### 第一步：安装脚本管理器
你需要一个浏览器扩展来运行此脚本，强烈推荐安装：
- 🟢 [ScriptCat (脚本猫)](https://scriptcat.org/) - 推荐！支持 Edge, Chrome, Firefox 等主流浏览器，更适合国内网络环境。
- 🟢 [Tampermonkey (篡改猴)](https://www.tampermonkey.net/) - 支持 Chrome, Edge, Safari, Firefox 等主流浏览器。

### 第二步：一键安装脚本
点击下方的链接，你的脚本管理器会自动弹出安装界面，点击**“安装”**即可。
👉 **[一键安装 DS Enhance Max (脚本猫)](https://scriptcat.org/zh-CN/script-show-page/7372)**
*(备用线路)* 👉 **[一键安装 DS Enhance Max (GitHub)](https://raw.githubusercontent.com/TRYuuu233/DS-Enhance-Max/main/ds-enhance-max.user.js)**

### 第三步：见证奇迹
刷新你的 [DeepSeek Chat](https://chat.deepseek.com/) 页面，尽情享受满血版带来的极致效率吧！

---

## 📸 界面预览 (Screenshots)

*(欢迎在项目发布后补充运行截图或 GIF 动图)*

---

## 👨‍💻 贡献与支持 (Contributing & Support)
如果这个项目极大地提升了你的工作效率，请在右上角给我点一个 **⭐ Star**，这是对我最大的鼓励！
如果你发现了 Bug 或是对功能有更好的建议，欢迎提交 [Issues](https://github.com/TRYuuu233/DS-Enhance-Max/issues) 或 Pull Requests。

## 📄 开源协议 (License)
本项目采用 [MIT License](LICENSE) 协议完全开源。

<div align="center">
  <sub>Built with ❤️ by <b>TRYuuu</b>. Make AI Chat Great Again.</sub>
</div>
