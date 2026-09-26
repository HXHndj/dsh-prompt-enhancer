# dsh-prompt-enhancer

A DeepSeek Harness (DSH) plugin with **one core capability**:

- ✨ **Prompt enhancement** — rewrite composer drafts in place with one click, fully undoable

[![Release](https://img.shields.io/github/v/release/HXHndj/dsh-prompt-enhancer)](https://github.com/HXHndj/dsh-prompt-enhancer/releases)
[![Release date](https://img.shields.io/github/release-date/HXHndj/dsh-prompt-enhancer)](https://github.com/HXHndj/dsh-prompt-enhancer/releases)
[![Stars](https://img.shields.io/github/stars/HXHndj/dsh-prompt-enhancer)](https://github.com/HXHndj/dsh-prompt-enhancer/stargazers)

## ✨ Core feature

### Prompt enhancement (✨)

The ✨ button in the composer toolbar triggers an independent LLM call and rewrites the current draft in place; keep refining, undo anytime, or cancel while enhancing.

- **One-click enhance** — the ✨ button triggers an independent LLM call and replaces the draft; continue refining, undo anytime, cancel while enhancing
- **5 optimization modes** — Basic (direct) / Lite (previous-round context) / Standard (rules + retrieval) / Expert (task analysis + full retrieval) / One-click Publish (complete dev-spec generator)
- **Memory switch** — when on, pre-send rounds (optimize → edit → re-optimize) accumulate into a memory chain the next round replays and senses your edit direction; sending the message clears it; when off, nothing is read or written
- **Model** — single-model configuration with optional thinking toggle/level and inline connectivity tests

## 🔧 Other capabilities

- 🌐 **i18n** — follows the DSH interface language (中文 / English)

## 🚀 Install

```sh
dsh plugin --profile web add github:HXHndj/dsh-prompt-enhancer#v3.5.3
```

Restart DSH (`dsh web`) after installing — the ✨ button appears in the composer toolbar.

> ℹ️ **Version note**: speech recognition has been stripped from this plugin (the official DSH desktop app already ships speech recognition), which makes it a **prompt-enhancement (✨) single-feature plugin**; the command above is pinned to v3.5.3 (it includes the ✨ official slot-contract fix, Issue #8 / #10). **Note**: from v3.4.0 the **in-plugin restart capability is removed** (restart DSH manually after an update); v3.5.0 **removes speech recognition** (all `voice/*` RPCs are gone — BREAKING); from v3.5.1 model configuration is single-select; v3.5.2 restructured the settings UI hierarchy; v3.5.3 turns the composer control into a split button (✨ enhance + ▾ menu: memory toggle / enhance-model switch / thinking level) — see [release notes](release-notes/3.5.3.md).
>
> Requires [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installed locally and `pnpm` in PATH.
>
> **Composer toolbar (✨) client contract**: the composer button and the error strip mount on the session-scoped slots `conversation.input.right` / `conversation.input.dock`. The official renderer (`@deepseek-ai/dsh-client-ui-renderer` ≥ 0.1.2-rc.1; web and DSH Desktop share the same source) injects **a `sessionId` prop, `useSession`/`useInput` selector hooks, and an `inputActions` prop** into slot entries (it never provides `props.session` / `props.input`); the plugin reads state through that contract since that fix (Issue #8 / #10, commit `0197ae7`, released with `v3.4.0`) and keeps a fallback for older hosts that provide the `props.session` / `props.input` shape. Third-party client renderers must implement the same contract (`sessionId` plus the hooks and actions above) for ✨ to render.

Update / remove:

```sh
dsh plugin --profile web update dsh-prompt-enhancer
dsh plugin --profile web remove dsh-prompt-enhancer
```

> After `remove`, restart DSH to fully unload the running instance.
>
> After an update is installed, restart DSH manually for it to take effect (the plugin no longer restarts DSH for you).

## 📦 Library notes

Core logic lives in standalone Node modules, reusable from other scripts: `lib/updater-host.cjs` (update executor: download / verify / install / rollback), `lib/platform-service.cjs` (cross-platform service management), `lib/sys.cjs` (env & paths). See each module's header comments.

## 🎯 Usage (prompt enhancement)

1. Type any non-empty text (slash commands keep their prefix; only the body is optimized)
2. Click the **✨** button
3. Wait for the independent LLM call; the draft is replaced with the enhanced version
4. Not satisfied? Click **Undo** to restore the original

## ⚙️ Configuration

Settings → "Models & plugins":

| Tab | Description |
|---|---|
| **Model configuration** | Configure the single optimization model (legacy multi-model queue configs are flagged and converge on your next change) |
| **Optimization parameters** | Mode / memory switch / context budget / timeout & output limits / templates |

## 📚 Docs

- [Releases](https://github.com/HXHndj/dsh-prompt-enhancer/releases)
- [CHANGELOG](CHANGELOG.md)
- [Compatibility notes](docs/compatibility-matrix.md)

> Privacy: the plugin records or reports nothing; enhanced results come from an external LLM — verify before sending.

