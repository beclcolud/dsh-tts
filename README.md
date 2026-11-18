# dsh-tts

给 DSH 用的本地配音工作台：**文案 → 人声 + 逐句字幕**（可出带字幕成片），中 / 英 / 日三语；
也能按剪辑时间轴分段配音、从已有视频反听字幕、单句重录后拼回整段。**全程离线**，不需要 API Key。

---

## ⚠️ AI 生成声明

本项目的**代码、测试、文档基本都由生成式 AI 完成**；仓库维护者**没有编程能力**，无法独立审查代码。
项目按「原样」提供、**不作任何担保**，使用风险自负。

AI 参与了什么、维护者能保证什么、使用前该做哪些检查，见 **[AI声明](AI声明.md)**。
许可证：MIT，见 [LICENSE](LICENSE)。

---

## 下载内容与依赖

### 1. 运行环境

| 项 | 要求 |
| --- | --- |
| Python | 3.13（实测用 ComfyUI 便携包的 python_embeded） |
| GPU | NVIDIA；单模型峰值约 3.5 GB，6 GB 显存够用 |
| ffmpeg | 需要在 PATH 里 |
| 磁盘 | 模型约 9.4 GB（全选含可选项约 18 GB） |
| 网络 | **只有两步要联网**：装依赖、首次下模型。日常使用完全离线 |

依赖版本已逐个钉死在 [requirements/](requirements/)（38 个包 + 三份 torch 变体），
用 [bootstrap_env.py](bootstrap_env.py) 做探测 / 安装 / 打桩 / 自检。

### 2. 模型（默认放在 `models/` 下）

| 目录 | 用途 | 大小 | 必选 |
| --- | --- | --- | --- |
| `Qwen3-TTS-0.6B-CustomVoice` | 预设音色（Serena 等） | 2.5 GB | ✅ |
| `Qwen3-TTS-0.6B-Base` | 参考音频克隆音色 | 2.5 GB | ✅ |
| `Qwen3-ASR-0.6B` | 质检回读、反听字幕 | 1.9 GB | ✅ |
| `Qwen3-ForcedAligner-0.6B` | 字级对齐（`align: true`、反听） | 1.8 GB | 可选 |
| `nllb-200-distilled-600M` | 中/英/日 互译 | 2.5 GB | 可选 |
| `Qwen3-TTS-1.7B-VoiceDesign` | 用一段描述造音色 | 4.5 GB | 可选 |

清单位于 [models.manifest.json](models.manifest.json)（含每个模型应有的文件与字节数，可校验半截下载）。

**下载**（走 hf-mirror，可续传）：

```bash
python bootstrap_env.py --download-models                    # 下载全部缺失的（跳过已弃用的）
python bootstrap_env.py --download-models --model base,custom # 只下指定的
python bootstrap_env.py --download-models --dry-run          # 只看要下多少
```

模型 key：`base` `custom` `asr` `aligner` `design` `mt` `custom17b`（已弃用）。
不装对齐器：`align: true` 与反听不可用，其余照常。不装翻译模型：只是没有翻译功能。

### 3. 安装

**插件**（DSH 运行时锁着 profile，必须先完全退出 DSH）：

```bash
node scripts/install.mjs            # 安装
node scripts/install.mjs --uninstall
```

Windows 也可以双击 `一键安装.cmd`；Linux / macOS 用 `./一键安装.sh`。装完重启 DSH。

**Python 依赖与模型校验**：

```bash
python bootstrap_env.py                 # 只探测
python bootstrap_env.py --install       # 安装依赖（--torch none 可复用宿主 torch）
python bootstrap_env.py --check-models  # 校验模型文件是否完整
python bootstrap_env.py --verify        # 起服务合成一句 + ASR 回读，端到端自检
```

---

## 简要使用方法

### 1. 配置（`cordis.patch.yml`）

最少填这几项，其余留默认即可：

```yaml
pythonPath: '…/python_embeded/python.exe'
libs:       '…/_tts_probe/pylibs'
models:
  custom: '…/Qwen3-TTS-0.6B-CustomVoice'
  base:   '…/Qwen3-TTS-0.6B-Base'
  asr:    '…/Qwen3-ASR-0.6B'
workDir: '…/配音'        # 产物根目录
defaultVoice: '新闻联播音色'
```

可选项：`models.aligner`、`mtModel`、`language`（zh/en/ja）、停顿与音质参数——见 [使用手册 §8](使用手册.md)。

### 2. 三个工具

```js
// 一段文案 → mp3 + 逐句 SRT（+ 可选 mp4）
voiceover({ text: '今天聊三个问题。第一……', voice: '新闻联播音色' })

// 按 PR 时间轴分段配音：先预检，再合成
voiceover_timeline({ xmlFile: '序列 01.xml', scriptFile: '文案.txt', stage: 'plan' })
voiceover_timeline({ xmlFile: '序列 01.xml', scriptFile: '文案.txt', stage: 'run' })

// 某一句重录，并拼回整段
voiceover_retakes({ text: '……', segment: 3, takes: 3 })
voiceover_retakes({ text: '……', segment: 3, use: 2, full: '长文案回归' })
```

常用开关：`language: zh/en/ja`、`translate: { from, to }`、`align: true`（字级字幕）、
`video: true`（出成片）、`toneTameDb: -4`（声音刺）、`peakCeiling: 0.7`（声音爆）。

### 3. 工作台

右侧边栏「+」→「配音工作台」，五页：

| 页 | 干什么 |
| --- | --- |
| 任务 | 实时进度、取消 |
| 历史 | 产物列表，试听 / 下载 |
| 音色库 | 试听、改名、删除、用描述新建 |
| 队列 | 批量排队（单段文案 / PR 时间轴），串行跑 |
| 参数 | 查看并修改配置，标注哪些需重启 |

页面文件是 `server/studio.html`，**改完刷新即生效**，不用重启 DSH。

---

## 文档

| 文档 | 看它解决什么 |
| --- | --- |
| [使用手册](使用手册.md) | **日常操作**：参数全表、调参、队列、多语言、常见问题 |
| [维护笔记](维护笔记.md) | 架构、拼接规则、**踩坑记录**（改代码前先读）、已知局限 |
| [HANDOVER](HANDOVER.md) | 交接：模块职责、版本变更、剩余问题 |
| [requirements](requirements/README.md) | 依赖环境：为什么钉版本、三处上游坑、平台矩阵 |
| [AI声明](AI声明.md) | AI 参与范围与责任边界 |
