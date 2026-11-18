# dsh-tts

**给 DSH 用的本地配音工作台**：文案进，人声 + 逐句字幕（可选带字幕成片）出；
也能按剪辑时间轴分段配音、从已有视频里反听字幕、对单句重录再拼回整段。

**全程离线**：Qwen3-TTS + Qwen3-ASR + 强制对齐 + 本地翻译模型，不联网、不需要 API Key、不产生任何调用费用。

## 定位：它是什么，不是什么

**是**——为「把成稿文案变成可以直接进剪辑软件的人声」设计的工作流工具：

- 单人配音为主（中文 / 英文 / 日文），自动逐句字幕
- 与 PR 剪辑绑定：按范围标记分段交付，时间对得上
- 已有片子需要字幕时，直接从原片反听
- 声音不满意时，**只重录那一句**，其余不动

**不是**——不负责这些（明确不做，避免误用）：

| 不是 | 说明 |
| --- | --- |
| 多说话人对口型 / 声音克隆换脸 | 只做单人旁白；多人对白只支持"按时间轴切段、每段一个音色" |
| 云端 TTS 的替代品 | 音质取决于本机 0.6B 模型；不追求商业级拟真 |
| 剪辑软件 | 不剪画面、不写回 PR 工程，只按标记给素材 |
| 通用翻译/字幕工具 | 翻译只服务配音流程（中/英/日），不做字幕文件格式转换（只出 SRT） |
| 实时配音 | 一次一段、串行跑；长文案按批合成，不追求低延迟 |

## 能做什么

| 能力 | 怎么用 |
| --- | --- |
| 文案 → 配音 + 逐句字幕 | `voiceover`（音色：预设名 / 描述造音色 / 参考音视频克隆 / 音色库名） |
| 直接出带字幕的 mp4 | `voiceover({ video: true })` |
| 按 PR 时间轴分段配音 | `voiceover_timeline`：stage=plan 预检 → stage=run 合成 |
| 从原片反听字幕 | 文案写 `04S/` 且正文留空 |
| 单句重录并拼回整段 | `voiceover_retakes`（按采样点边界替换） |
| 中/英/日 三语 | `language: zh / en / ja` |
| 先翻译再配音 | `translate: { from, to }`（本机 NLLB，离线） |
| 批量排队 | 工作台「队列」页：单段文案 / PR 时间轴都可排队 |
| 看进度、取消、翻产物、管音色、改参数 | 右侧边栏「配音工作台」 |

## 五分钟上手

```js
// 1) 出第一条配音（默认音色）
voiceover({ text: '今天聊三个问题。第一……', voice: '新闻联播音色' })

// 2) 不确定用哪个音色：先出候选（描述造音色，自动入库）
voiceover({ text: '……', voice: '低沉沙哑的中年男声', candidates: 3 })

// 3) PR 剪好的片：先预检，再合成
voiceover_timeline({ xmlFile: '序列 01.xml', scriptFile: '文案.txt', stage: 'plan' })
voiceover_timeline({ xmlFile: '序列 01.xml', scriptFile: '文案.txt', stage: 'run' })
```

装好之后，右侧边栏「+」→「配音工作台」有完整界面：任务进度、历史产物、音色库、队列、参数。

## 文档地图

| 文档 | 看它解决什么 |
| --- | --- |
| [使用手册](使用手册.md) | **日常操作看这个**：参数全表、调参、队列、多语言、常见问题 |
| 本页（README） | 项目定位、架构、安装、**踩过的坑**（改代码前先读） |
| [HANDOVER.md](HANDOVER.md) | 交接与维护：模块职责、各版本改了什么、已知限制 |
| [requirements/README.md](requirements/README.md) | 依赖环境：版本钉死原因、三处上游坑、平台矩阵 |

## 架构

```
DSH 宿主进程
  └─ dsh-tts 插件 (lib/index.js)
       ├─ 首次调用拉起 server/tts_server.py（常驻，空闲自动退）
       ├─ 工作台接口：status / cancel / outputs / bank / config / queue / docx
       ├─ 解析层：xml.js（手写 XML）、timeline.js、script.js、plan.js
       ├─ 工具层：synth.js（分批/续跑/字幕分组）、picks.js（选版记录）
       ├─ 运行时：guard.js（工具互斥）、queue.js（串行队列）、platform.js、docx.js（Word 抽取）
       └─ 音色库：<workDir>/voicebank/index.json
  server/tts_server.py
       ├─ 一次只驻留一个模型（CustomVoice / VoiceDesign / Base / ASR / 对齐器）
       ├─ 逐句合成 + 响度对齐 + 拼接（目标停顿 + 供体填充）
       ├─ 对齐 / ASR / 翻译（NLLB，CPU）/ UVR 人声分离
       └─ 页面：server/studio.html（工作台，按请求现读，改完刷新即生效）
```


**平台**：安装、路径、编码都已按平台分支处理（Windows 用 junction，POSIX 用符号链接；
ffmpeg concat 列表只在 Windows 上把反斜杠换成斜杠）。但**所有实测都在 Windows + NVIDIA 上做过**，
Linux / ROCm 的代码路径写好了、分支有单测，尚未真正执行过——上 Linux 请先跑 `python bootstrap_env.py --verify`。

## 关键参数（cordis.patch.yml）

| 键 | 默认 | 含义 |
| --- | --- | --- |
| defaultVoice | 新闻联播音色 | 不指定音色时用它 |
| edge_keep_ms | 25 | 每句两端保留的静音（毫秒） |
| fade_ms | 3 | 每段边缘淡入淡出，防爆音 |
| overlap_ms | 10 | 接缝交叠时长 |
| overlap_trigger_ms | 120 | **只有接缝空隙超过它才交叠** |
| diction | true | 附加「咬字清晰、不要连读」指令 |
| blur_mode / blur_sep / blur_words | punct / 、 / [答案, 牛奶] | 易粘连词的断字方式 |
| idleShutdownMs | 300000 | 服务空闲多久自动退出（0 = 常驻） |
| busyWaitMs | 0 | 忙的时候最多等多久（毫秒）。0 = 立即失败并提示，调大就排队 |
| seamPolicy | target | 句间停顿策略：target 按句末标点规整到设定值 / current 只看模型给多少 |
| seamPauses | {'。':180, '！':200, '？':200, '；':140} | 各句末标点对应的停顿时长（毫秒），可按语气场合调 |
| language | zh | 默认合成语言：zh / en / ja |
| mtModel | （按 workDir 的上一级 models/ 找） | 翻译模型目录（NLLB-200-distilled-600M） |
| peakCeiling / toneTameDb | 0.95 / 0 | 峰值上限、高频层降（治"爆"与"刺"） |

## 已知局限

- **前后鼻音**：-in/-ing 这类字偶有偏差，标点/指令/EQ 都改不了发音本身；ASR 转写正常，说明是音值问题而非读错字。
- **0.6B 的时长波动**：同一句 ±0.5s，需要逐句选版才能稳定。
- **显存**：单模型峰值约 3.5GB，6GB 卡够用；模型只能串行驻留，切换 5~8 秒。
- **英文/日文的断词是近似的**：中文用 jieba，英文按空格，日文按「助词/标点」——日文没有真正的形态素分析，专有名词可能断得不理想。
- **翻译是通用模型**（NLLB-600M）：术语与语气会有偏差，重要文案建议人工校对。
- **Windows 上缺 nagisa**：日文对齐靠一个规则分词替身（`server/vendor/nagisa.py`），能跑但不如真库准。
- **平台**：全部实测在 Windows + NVIDIA 上完成；Linux/ROCm 代码路径已有、平台分支有单测，但未真机验证。
- **时间轴只解析 PR 的 FCP 7 XML**：达芬奇/FCP X 原生格式、EDL 不支持（会给明确提示）。

## 目录

```
dsh-tts/
├── lib/            index.js（三个工具 + 工作台接口）· client.js（侧边栏入口 + 状态点）
│                   synth.js · picks.js · queue.js · guard.js · platform.js · docx.js
│                   xml.js · timeline.js · script.js · plan.js · audio.js · clips.js
├── server/         tts_server.py · studio.html（工作台页面）
│                   vendor/（sox 桩、nagisa 替身）
├── scripts/        install.mjs · bootstrap 相关 · test_*.mjs/py · fixtures/
│                   md_to_docx.py（Markdown 转 Word）
├── requirements/   固定版本的依赖清单与平台说明
├── cordis.patch.yml    运行配置（音色、停顿、并发、语言、翻译模型…）
├── models.manifest.json 模型清单与校验
├── 使用手册.md · HANDOVER.md · README.md
├── 一键安装.cmd / 一键卸载.cmd（Windows）· 一键安装.sh / 一键卸载.sh（POSIX）
└── bootstrap_env.py    环境自举：探测 / 安装 / 打桩 / 自检
```
