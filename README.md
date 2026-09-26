# dsh-prompt-enhancer

DeepSeek Harness (DSH) 插件。**核心能力**：

- ✨ **提示词增强** — 输入框草稿一键改写，不满意可撤回

[![Release](https://img.shields.io/github/v/release/HXHndj/dsh-prompt-enhancer)](https://github.com/HXHndj/dsh-prompt-enhancer/releases)
[![Release date](https://img.shields.io/github/release-date/HXHndj/dsh-prompt-enhancer)](https://github.com/HXHndj/dsh-prompt-enhancer/releases)
[![Stars](https://img.shields.io/github/stars/HXHndj/dsh-prompt-enhancer)](https://github.com/HXHndj/dsh-prompt-enhancer/stargazers)

## ✨ 核心功能

### 提示词增强（✨）

输入框工具行的 ✨ 按钮触发一次独立 LLM 调用，直接改写当前草稿；可继续优化、可撤回、增强中可取消。

- **一键增强** — ✨ 按钮触发独立 LLM 调用，直接替换草稿；可继续优化、可撤回、增强中可取消
- **3 档优化模式（v4.0.0）** — 轻量（快速润色，零增量）/ 标准（默认：意图与目标识别 + markdown 结构化输出）/ 专家（标准之上 + 要素盘点 + 歧义澄清）；每档可挂自定义模板
- **专家档澄清卡** — 草稿存在会实质改变优化结果的歧义时，输入框下方弹出选择题卡片（≤3 题），作答或跳过后生成终稿
- **记忆流** — 默认开启：发送前的多轮「优化→修改→再优化」累积为记忆链，下一轮代入历史并感知修改方向；专家档澄清问答一并入链；发送消息即清空，可关闭（记住开关状态）
- **模型** — 单模型配置，可选思考开关/等级、行内连通性测试

## 🔧 其他能力

- 🌐 **多语言** — 按钮与文案跟随 DSH 界面语言（中文 / English）

## 🚀 安装

```sh
dsh plugin --profile web add github:HXHndj/dsh-prompt-enhancer#v4.0.0
```

安装后重启 DSH（`dsh web`），输入框工具行出现 ✨ 按钮即安装成功。

> ℹ️ **版本说明**：本插件已剥离语音识别（DSH 官方桌面端已内置语音识别），现为**提示词增强（✨）单功能插件**；上方命令已锁定 v4.0.0。**v4.0.0（BREAKING）**：五模式收敛为**轻量/标准/专家**三档（默认标准），移除全部会话/工作区/网络检索，T1/T2 双模板由档位吸收，新增专家档歧义澄清卡与证据正文防注入；记忆流默认开启、可关；上下文预算改为全局记忆链预算（4000/8000/16000）；旧配置自动迁移（模式 base→standard、smart/publish→expert 等）。历史：v3.4.0 起移除插件内重启能力；v3.5.0 移除语音识别（BREAKING）；v3.5.1 起模型配置为单选；v3.5.3 输入框改分裂按钮；v3.5.4 ▾ 菜单两级下钻；v3.5.6 ▾ 菜单新增「模式切换」入口，详见 [release notes](release-notes/4.0.0.md)。
>
> 需本机已装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 且 `pnpm` 在 PATH 中。
>
> **输入框工具行（✨）客户端契约**：输入框右侧按钮与错误提示挂载在会话级槽位 `conversation.input.right` / `conversation.input.dock`。官方渲染器（`@deepseek-ai/dsh-client-ui-renderer` ≥ 0.1.2-rc.1，web 与 DSH Desktop 同源）向槽位条目注入 **`sessionId` prop + `useSession`/`useInput` 选择器 hook + `inputActions` prop**（不提供 `props.session` / `props.input`）；插件自该修复（Issue #8 / #10，commit `0197ae7`，自 `v3.4.0` 起随 tag 发布）起按该契约取值，并兼容旧宿主（提供 `props.session` / `props.input` 形态）。第三方客户端渲染器若以其它方式提供会话/输入状态，需实现同一契约（`sessionId` + 上述 hooks 与 actions），✨ 方可显示。


更新 / 卸载：

```sh
dsh plugin --profile web update dsh-prompt-enhancer
dsh plugin --profile web remove dsh-prompt-enhancer
```

> 卸载后必须重启 DSH 才能从运行中移除。
>
> 更新安装完成后需**手动重启 DSH** 生效（插件不再代为重启）。

## 📦 库说明

核心逻辑拆分为独立 Node 模块，可复用：`lib/updater-host.cjs`（更新执行器：下载 / 校验 / 安装 / 回滚）、`lib/platform-service.cjs`（跨平台服务管理）、`lib/sys.cjs`（环境与路径）。详见各模块头注释。

## 🎯 使用（提示词增强）

1. 输入任意非空文本（斜杠命令保留前缀，只优化正文）
2. 点击 **✨** 按钮
3. 等待独立 LLM 调用完成，草稿被替换为增强版本
4. 不满意点击 **可撤回** 恢复原文
5. 专家档遇到阻塞级歧义时，输入框下方弹出**澄清选项卡**——作答「提交并继续」、或「跳过直接优化」（歧义点保持原文原样）、或取消恢复草稿

## ⚙️ 配置

设置 →「模型与插件」：

| Tab | 说明 |
|---|---|
| **模型配置** | 配置优化所用单模型（旧版多模型队列配置将提示并在下次修改后收敛） |
| **优化参数** | 优化模式（轻量/标准/专家，默认标准）/ 记忆流（默认开）/ 上下文预算（4000/8000/16000，记忆链总预算）/ 超时·Token·输出上限（按档位）/ 模板（每档内置一套 + 自定义） |

## 📚 文档

- [Releases](https://github.com/HXHndj/dsh-prompt-enhancer/releases)
- [CHANGELOG](CHANGELOG.md)
- [兼容性说明](docs/compatibility-matrix.md)

> 隐私：插件不记录、不上报任何数据；增强结果来自外部 LLM，发送前请自行核对。

