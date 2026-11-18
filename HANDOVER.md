# dsh-tts 插件交接文档

> ⚠️ 本仓库的代码、测试与文档主要由生成式 AI 生成，维护者没有编程能力、无法审查代码。
> 接手前请先读 [AI声明](AI声明.md)：那里写清了可依赖的程度与使用前的检查项。
>
> 交接范围：**只讲插件本身**。项目（vlog）制作过程只保留"与插件工作直接相关"的部分——即插件在真实项目里暴露了什么缺陷、怎么修的、还差什么。
> 读者：接下来维护这个插件的人。读完应当能在新机器上装起来、跑通三个工具、并知道哪些坑还没填。

---

## 一、当前状态一览

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 文案 → 配音 + 逐句字幕 + 成片 | ✅ 可用 | 0.6B CustomVoice + 克隆音色；长文案分批续跑；实测 5 分钟片可用 |
| 按 PR 时间轴分段配音 | ✅ 可用 | 只吃 PR 导出的 FCP XML（xmeml），已在真实项目（10 标记 / 5 分钟片）上跑过；其他格式会给明确提示 |
| 原片反听生成字幕 | ✅ 可用 | 文案写 `04S/` 且正文留空，自动切音频 → ASR → 对齐 → 并入全片 SRT |
| 句子级重录 + 拼回 | ✅ 可用 | 按采样点边界替换（`bounds.json`），长文案也有边界了 |
| 多语言 | ✅ 中/英/日 | 断句、语速、ASR、对齐都按语言切换 |
| 离线翻译 | ✅ 中英日互译 | NLLB-200-600M，CPU；术语质量一般，重要文案需校对 |
| 工作台（进度/历史/音色库/队列/参数） | ✅ 可用 | 右侧边栏标签；读取走文件系统，不启动服务 |
| 批量队列 | ✅ 可用 | 串行；单段文案与 PR 时间轴都能排队；只在内存里 |
| 本地服务常驻 / 空闲自退 | ✅ 可用 | 端口 17321，仅监听 127.0.0.1，无鉴权 |
| 1.7B CustomVoice 路线 | ❌ 已放弃 | 节奏失控、耗时不可控，见第八节 |

代码规模：**约 7000 行**（JS + Python + 页面），无第三方运行时依赖（ffmpeg 除外，需在 PATH）。

---

## 二、代码结构

```
dsh-tts/
├── lib/
│   ├── index.js     794 行  三个工具 + 服务生命周期 + 音色解析 + ffmpeg 调用
│   ├── client.js    172 行  Web 端：播放卡片（toolview）+ 状态圆点（composer dock）
│   ├── xml.js       127 行  手写 XML 解析（不引依赖，只够读 xmeml）
│   ├── timeline.js   56 行  从 xmeml 取序列与标记（start/end/name）
│   ├── script.js     54 行  文案格式解析：01/ 正文、02S/ 仅字幕、03V/ 仅配音
│   ├── plan.js      124 行  预检：预计时长 vs 标记范围，阈值 0.3 秒
│   ├── audio.js      71 行  WAV 读取 + 停顿检测（重录打分用）
│   └── clips.js      71 行  从 XML 取媒体片段（区间覆盖去重）+ 路径解码
├── server/
│   └── tts_server.py 764 行  本机常驻 HTTP 服务，独占 GPU 模型
├── scripts/        安装、测试、音色库维护、md_to_docx.py；一次性脚本归档在 one-off/（72 个）
├── cordis.patch.yml  配置（插件唯一需要改的文件）
├── 一键安装.cmd / 一键卸载.cmd
├── README.md         面向使用者的说明 + 踩坑记录
└── HANDOVER.md       本文档
```

### 数据流

```
工具调用 (index.js)
   ├─ ensureService()  → 无服务则 spawn python server/tts_server.py
   ├─ resolveVoice()   → 预设名 / 中文描述 / 参考素材 / 音色库名 四种归一
   ├─ POST /say        → 服务端逐句合成、拼接、出 wav + srt
   └─ ffmpeg           → mp3 / 写字幕 / 出 mp4
```

---

## 三、三个工具

### 1. `voiceover` — 文案直出

| 参数 | 说明 |
| --- | --- |
| `text` / `textFile` | 文案 |
| `voice` | 预设名、中文描述、参考音视频路径、音色库名，四选一 |
| `mode` | preview（候选短样）/ render（全长）/ auto |
| `candidates` | 候选数 1–5 |
| `timeline` | 多角色数组 `[{start,end,voice,text}]` |
| `video` / `background` / `width` / `height` | 出 mp4 |
| `qualityCheck` | ASR 回读校验（默认开） |

产物：`<title>.wav/.mp3/.srt`，可选 `.mp4`。

### 2. `voiceover_timeline` — 按剪辑时间轴配音

两阶段：`stage=plan`（只算时长，不花 GPU）→ 确认后 `stage=run`。

| 参数 | 说明 |
| --- | --- |
| `xmlFile` | PR 导出的 FCP XML |
| `scriptFile` | 文案，`01/正文`、`02S/`（仅字幕）、`03V/`（仅配音） |
| `stage` | plan / run |
| `mode` | both / voice / subtitle（文案后缀优先） |
| `voice` | 同 `voiceover`，留空用 `defaultVoice` |
| `outDir` / `charsPerSecond` / `sequence` | 产物目录 / 预估语速 / 多序列选择 |

产物：每段 `<编号>.wav/.mp3/.srt` + `voiceover.srt`（绝对时间）+ `reconcile.csv`（对账表）。

### 3. `voiceover_retakes` — 句子级重录

| 用法 | 说明 |
| --- | --- |
| `segment=N, takes=K` | 对文案第 N 句出 K 版，每版测内部停顿数并标异常 |
| `use=J` | 记录第 J 版为采用版，写入 `<workDir>/takes/picks.json` |

**注意：它只记录选择，不会把选中的那版拼回原段落。** 见第九节。

---

## 四、服务端 `tts_server.py`

单进程，`ThreadingHTTPServer`，**绑定 127.0.0.1**，无认证，路径 `POST /`，请求体 `{"req": ...}`。

| 端点 | 作用 |
| --- | --- |
| `health` | 在线状态、当前加载的模型、空闲秒数 |
| `shutdown` | 卸模型并退出（**停服务只能用这个，taskkill 常因权限失败**） |
| `say` | 核心：逐句合成 → 紧裁 → 淡入淡出 → 响度对齐 → 接缝处理 → 归一 → wav + srt |
| `preview` | 候选短样（多音色/多描述并排） |
| `timeline` | 按段落数组合成并拼接 |
| `separate` | UVR 分离人声/伴奏 + 自动选干净 9 秒 + ASR 转写参考文本 |
| `asr` | 整段转写 |
| `asr_subs` | 转写 + 按句分配时间轴 + 直接出 SRT |
| `bank_list` / `bank_add` | 音色库读写 |

### 模型管理

一次只驻留一个，切换时先卸再载（8GB 显存跑不动两个）：

| key | 模型 | 体积 | 用途 |
| --- | --- | --- | --- |
| `custom` | Qwen3-TTS-0.6B-CustomVoice | 2.4G | 预设音色 |
| `design` | Qwen3-TTS-1.7B-VoiceDesign | 4.3G | 中文描述造音色 |
| `base` | Qwen3-TTS-0.6B-Base | 2.4G | 克隆音色（**实际主力**） |
| `asr` | Qwen3-ASR-0.6B | 1.8G | 质检 / 反听字幕 |

1.7B-CustomVoice（4.3G）也在磁盘上，但**已放弃**，配置里没有引用。

### 拼接参数（实测定稿，改动前先听）

```
逐句合成 → 两端紧裁 edge_keep_ms(25) → fade_ms(3) 淡入淡出
→ 句间响度对齐(±6dB) → 按句末标点把接缝停顿规整到 seamPauses（默认 180/140ms）
   → 补出来的停顿填同电平柔和噪声（测得的自然底噪约 -60~-66 dBFS）
→ 整段按 RMS −20 dBFS 归一（峰值 0.95 兜底）→ 按实际起始时间重算字幕
```

**2026-11-17 变更**：原「空隙 >120ms 才交叠 10ms」这条**已不再触发**。原因是裁切与接缝测量
用了两套阈值（峰值×0.5% vs 绝对值 0.01），克隆音色的底噪卡在中间，导致半秒多静音既没被裁掉、
又被当成"很长的空隙"。统一判据后接缝固定在约 50ms，交叠失去触发条件。

---

## 五、安装与部署

### 依赖的 Python 环境（**最容易踩的地方**）

不是标准 venv，是 **ComfyUI 便携包自带的 Python**：

```
E:\<工作区>\ComfyUI\ComfyUI_windows_portable\python_embeded\python.exe
```

额外库装在 `_tts_probe/pylibs`（由 `libs` 配置注入 `sys.path`）：38 个包，逐包 pin 在 `requirements/base.txt`。

**换机器怎么装**：`requirements/` 里有完整清单与平台矩阵，`bootstrap_env.py` 负责探测、安装、打补丁、自检。三条命令：

```bash
python bootstrap_env.py                  # 只探测，不改任何东西
python bootstrap_env.py --install --torch none   # 复用宿主 torch，装其余依赖
python bootstrap_env.py --verify         # 起服务 + 合成一句 + ASR 回读
```

**注意 transformers 的真实版本是 4.57.3，不是 4.57.6**（本段原文写错了）。qwen-tts 要 4.57.3、qwen-asr 要 4.57.6，依赖图无解；现做法是装 4.57.3 的代码 + 一份 4.57.6 的占位元数据。`nagisa` 的假模块**在服务端代码里**（`tts_server.py` 导入 qwen_asr 前注入），不是环境补丁，跟着代码走。详见 `requirements/README.md`。

### 插件安装

DSH 运行时锁着 profile 的 `package.json`，**必须完全退出 DSH**：

```bash
node scripts/install.mjs            # 装进 desktop profile，失败自动回滚
node scripts/install.mjs --uninstall
```

或双击 `一键安装.cmd`。原理：备份 profile → 改 `dependencies` + `dsh.profile.bundles` → 在 profile 的 `node_modules` 下建 `mklink /J` 软链 → 尝试 import 验证 → 失败回滚。

**`node` 不在 PATH**，脚本里硬编码了运行时路径：
`C:\Users\honor\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`

---

## 六、配置项（`cordis.patch.yml`）

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `port` | 17321 | 服务端口 |
| `pythonPath` | ComfyUI 便携包 python | 解释器 |
| `libs` | `_tts_probe/pylibs` | 额外库目录 |
| `models.*` | 见上表 | 四个模型路径 |
| `workDir` | `E:\<工作区>\配音` | 产物根目录 |
| `defaultVoice` | `新闻联播音色` | 不指定音色时用 |
| `idleShutdownMs` | 300000 | 空闲多久自退，0 = 常驻 |
| `diction` | true | 附加"咬字清晰、不要连读"指令 |
| `blur_mode` / `blur_sep` / `blur_words` | punct / 、 / [答案, 牛奶] | 易粘连词的断开方式 |
| `blur_gap_ms` | 80 | 拆字模式的断点毫秒（`split` 时才用） |
| `edge_keep_ms` / `fade_ms` / `overlap_ms` / `overlap_trigger_ms` | 25 / 3 / 10 / 120 | 拼接参数 |
| `logFile` | `配音/service.log` | 服务日志 |

**音色库**：`<workDir>/voicebank/index.json`，当前 13 条（3 条 custom、8 条 design、2 条 base 克隆）。默认音色 `新闻联播音色` 是 base 克隆（参考音频 `配音/ref-1794805281.wav`），条目上 `blur: false`（它自己念得清，不需要插顿号）。

---

## 七、真实项目里暴露的插件问题（只列与插件相关的）

| 现象 | 根因 | 处置 | 仍缺 |
| --- | --- | --- | --- |
| 897 字段落合成报 `HeadersTimeoutError` | 网关约 5 分钟断连，与插件自身超时是两回事 | 按句切分、每批 ≤300 字，拼回后按累计时长偏移字幕。**2026-11-17 补：此前只改了时间轴工具，主工具 `voiceover` 仍是整段单请求；现已一并分批，分片落盘可续跑，见第十三节** | 批间未做交叉淡化 |
| `03V/`（只配音）却混进 19 条字幕 | 字幕收集没区分 mode | `mode=voice` 跳过收集 | 合并全片字幕时仍靠脚本，未做工具化 |
| 时间轴工具不认克隆音色 | 直接拿 `defaultVoice` 当预设名传给服务 | 改走 `resolveVoice` | — |
| 按字幕时间切音频，前后句各被切掉一截 | 字幕时间是按字数比例的估算，不是发音边界 | 改为整段重跑 | **静音中点吸附的切片器仍未实现** |
| 某段听着像爆麦 | 输出峰值只有 0.08（低 22 dB），播放器拉满音量放大了模型的爆破音 | 按 RMS −20 dBFS 归一 + 峰值 0.95 兜底 | — |
| `展` 念成 `掌`、`一大` 吞字、`行色匆匆` 固定断开 | 克隆音色对该词组的固定读法，重录 3 次仍在同一位置 | 换说法（展览厅 / 第一次全国代表大会 / 匆匆走进） | 无发音词典或拼音注入能力 |

---

## 八、已放弃的方案（别再试一遍）

| 方案 | 为什么放弃 |
| --- | --- |
| Qwen3-TTS **1.7B** CustomVoice | 跨句主频波动 27–57Hz（0.6B 只有 1.2Hz）；关采样后更差（54.8Hz、单句 19s）；Vivian 曾 15 分钟跑不完一段 |
| 关采样 + 固定种子求稳定 | 贪心解码让 1.7B 更慢更飘 |
| 拆字拼接控制断点 | 断点精确，但元音衔接不自然，不如直接插顿号 |
| 用"鼻音比"（200–600Hz / 1.2–3.5kHz）自动择优 | 指标与听感**方向相反**，已证伪；`nasality()` 仍在代码里但默认 `takes=1` 不触发，**应删除** |
| 用 EQ 去鼻音 | 能提亮，但根因在音色与发音本身 |

---

## 九、未完成 / 半成品 / 已知缺陷

> 这一节是交接重点。**每一条都写明现状、为什么停在这、建议怎么接。**

### A. `voiceover_retakes` 不会自动拼回原段

- **现状**：能出 K 版、能测停顿、能记录 `picks.json`；选中后只复制成 `chosen-N.wav`，不改原段落。
- **为什么停在这**：拼回需要知道该句在原段里的精确时间区间。第一次我拿字幕时间当切点，结果前一版残留半句、后一版开头被削（字幕时间是估算值，不是发音边界）。
- **建议**：实现"能量检测找静音段 → 切点吸附到静音中点 → 替换 → 重算后续时间轴"。
- **更正（2026-11-17）**：原文说"`findPauses` 已能给出静音区间"**不成立**。它返回的是**停顿长度数组**（如 `[0.21, 0.35]`），没有起止时间，切片器要的第一块原语并不存在。
- **已解决（2026-11-17，v0.2.3）**：最后没走"检测静音"这条路。服务端合成时本来就知道每句被拼在第几个采样点，只是没记下来；现在顺手写进 `<stem>.bounds.json`。`voiceover_retakes` 传 `use=N` + `full=<整段>` 就按**样本区间**替换，其余句子时间轴按实际差值顺延。字幕不再参与剪辑点计算。限制：旧版本渲染的音频没有 bounds 文件，只能整段重跑。

### B. `picks.json` 缺约束

- 无音色维度：同一句换音色重录会互相覆盖。
- 无版本/撤销。
- 键只有句子序号，文案改了以后旧选择会对错句。
- **已解决（2026-11-18，v0.2.11）**：键改成 `<句序>@<文本hash>@<音色标签>`，值里带 `picks[]` 历史（最多 10 条）和 `current` 指针。实测：改文案后旧选择查不到（不再串句），同一句换音色重录也各自独立。旧文件读入时自动迁移到 version 2，旧条目会标 `migratedFrom: "v1"`、音色标 `unknown`。

### C. 原片人声反听字幕没接进工具

- **现状**：服务端 `asr_subs` 可用；`lib/clips.js` 能从 XML 取媒体片段并按区间去重；但**工具里没有入口**，这次是在 tools 之外用 `scripts/one-off/build_seg_audio.mjs` + 手工 curl + `scripts/one-off/merge_srt.py` 拼起来的。
- **为什么没接**：当时赶交付，先手工跑通再说。
- **已解决（2026-11-18，v0.2.10）**：就按上面建议做的。文案里写 `04S/` 且**正文留空**，run 时就自动走 `clips.js 取片段 → ffmpeg 切出这段 → asr_subs(timestamps) → 偏移合并进全片 SRT`。用真实项目（`序列 01.xml`，标记 04 = 151.76~161.48s）实测：切出 9.7 秒音频，转写 + 强制对齐，出 3 条字级字幕，全片 SRT 按入点偏移正确。
- 顺带把 `asr_subs` 升级成支持 `timestamps`：先转写、卸掉 ASR 再载对齐器，拿字级时间；对齐器不可用时自动退回原来"按字数分配"的结果并在日志里说明。

### D. 时间轴工具只支持一种输入格式

- **格式（部分改善，2026-11-18）**：仍然只**解析** PR 的 FCP 7 XML（xmeml），达芬奇 / FCP X 原生 / EDL 都不支持。但现在**不会静默解析出空结果**——会先认格式再报错：FCPXML 提示"在 PR 里导出 Final Cut Pro XML / 达芬奇导出 FCP 7 XML"，EDL 与"不是 XML"各有专门提示。
- **时码（已读）**：现在会读 `<timecode>` 的 frame/string，在预检里提示"起始时码非 0，工具按序列相对时间处理，若标记按绝对时码填会整体偏移"。**不做自动补偿**——无法可靠判断导出的是相对还是绝对帧，猜错比不猜更糟。
- **标记超界（已告警）**：标记结束时间超出序列时长时会提示，这通常是按时码填写的症状。
- **后缀冲突（已告警）**：标记名自带 S/V（PR 里常见 `03v/`、`07s/`）且推导出的模式与文案不一致时会提示"以文案为准"。两边一致时不报警，避免噪音。
- **仍未支持**：解析达芬奇/FCP X 原生 XML、EDL、ASS/TTML 输出、写回 PR 或生成 `.prproj`。

### E. 字幕时间仍是估算

- 分配方式是"按字数比例 + 向静音吸附"，**不是强制对齐**。实测 04 段计划 2.44s、实际 2.30s，误差约 6%。
- 影响：字幕与语音可能出现半句错位；跨语言或数字多的段落更明显。
- **已解决（2026-11-18，v0.2.8）**：接了 Qwen3-ForcedAligner。查证下来 `qwen_asr` 包里**本来就带** `Qwen3ForcedAligner`、ASR 也支持 `return_time_stamps=True`，之前缺的只是一个 1.84G 的权重。`voiceover({align:true})` 会把每个字对到音频上的真实时间，长句自动拆成多条字幕（实测 46 字 → 8 条，时间落在音频时长内）。
- **两个实测坑**：① 对齐器只吐"念出来的字"，**标点全丢**（30 字原文回 27 项），要靠原文补回去才能按标点断行；② `ForcedAlignItem` 的注解写 seconds、实际产出是毫秒，按音频时长判断一次再统一。
- **词边界（不切在词中间）**：对齐器对中文是逐字吐的（`tokenize_chinese_mixed` 每个汉字一个 token），没有词信息。
  - **先试了 BPE token 边界，结论是不够**：实测对同一句话，BPE 会允许多出 5 个"词内断点"（`清|早`、`菜|市场`、`摊|主`、`熟|客`、`打招|呼`），同时又漏掉 2 个该断的位置（`是|`、`的|`）——既太松又太紧。
  - **改用 jieba**：`jieba.tokenize()` 直接给 (词, 起, 止)，端点就是词边界。缺失时自动退回 BPE（日志会写明用的哪个）。
  - 实测 46 字 → 7 条，全部落在词边界上：`清早的菜市场是最热闹的地方，` / `摊主一边摆菜，` / `一边跟熟客打招呼；` / …
  - 另外标点一律挂在上一句尾巴上，不单独成条（否则会出现只有"、"、时长为 0 的字幕）。

### F. Python 环境无法一键复现

- 依赖 ComfyUI 便携包的 python + 手工 pip 到 `_tts_probe/pylibs`，**没有 requirements、没有安装脚本**。
- 三个已知修补（sox 桩模块、nagisa 假模块、regex 重装）都靠手工，未写进任何脚本。
- **已解决（2026-11-17，v0.2.4）**：`requirements/` 固定了 38 个包的精确版本、平台矩阵和三条已知坑；`bootstrap_env.py` 做探测/安装/打桩/自检。顺带查清了三件事：nagisa 的假模块本来就在服务端代码里（不是环境补丁）；transformers 实际生效的是 4.57.3 而不是文档写的 4.57.6；`gradio/julius/ml_collections/beartype/diffq_fixed` 是上游声明了但代码路径用不到的，装了只会拖重依赖。

### G. 模型不自动下载

- 四个模型需手工放到 `models/`，插件只读路径。换机器要重新下 11G。

### H. 服务生命周期

- **并发控制（2026-11-18 已做）**：三个工具外面加了一层进程内互斥（`lib/guard.js`）。忙的时候默认**立即失败**并说清楚谁在跑、跑了多久；想排队就把 `busyWaitMs` 调大。实测第二个请求 **0ms** 被拒。
- **忙状态可见（已做）**：服务端 `/health` 增加 `busy` / `busy_req` / `busy_s`；插件状态端点一并带出。实测合成中能看到 `busy:true, busy_req:"say", busy_s:6.1`。
- **并发拉起竞态（已修）**：两个调用同时发现服务没起时，原来会各自 spawn——第二个抢不到端口就退出，它的 exit 回调还会把正在用的引用清掉。现在用 `SERVICE.starting` 串起来只 spawn 一次；子进程退出时只清自己那次的引用。
- **启动即退出会立刻报错（已修）**：端口被占 / pythonPath 不对 / 依赖缺失时，原来白等满 90 秒才超时；现在当场报出退出码和原因。
- **更正**：原文说"端口被占时能抢占（会先发 shutdown）"**不准确**。代码里的 shutdown 只在"服务疑似被污染、重启后重试一次"那条路径上（voiceover 的 retry），并不存在端口占用时的自动抢占。
- 仍然没做：进程崩溃后没有自动重启（要等下一次工具调用拉起，这是原有取舍）；端口被别的程序占用时不会抢占，只会报错。
- 单进程单卡，切换模型 5–8 秒。
- 无鉴权（仅监听 127.0.0.1，风险可接受，但别改绑定地址）。

### I. 跨平台

- **安装（已做）**：`install.mjs` 按平台分支——Windows 用 `mklink /J`（junction，不需要管理员权限），POSIX 用符号链接。卸载时 POSIX 必须用 `unlink`：对符号链接调 `rmSync(recursive)` 会删到**目标目录**里去。另加了 `一键安装.sh` / `一键卸载.sh`。
- **路径（已做）**：ffmpeg concat 列表在 Windows 上必须把反斜杠换成斜杠；Linux 上反斜杠是合法的文件名字符，替换会改坏真实路径。抽成 `lib/platform.js` 的 `ffconcatPath()`，两种平台分支都有单测。
- **编码（已做）**：拉起 Python 时固定注入 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`，不依赖控制台代码页。
- **taskkill**：代码里本来就没用它——停服务一律走 HTTP `{"req":"shutdown"}`。文档里那几条"别用 taskkill"仍然成立。
- **⚠️ 仍然只在 Windows 上验证过**：全部实测、全部测试、模型推理都在 Windows + NVIDIA 上跑。Linux / ROCm / CPU 的代码路径已经写好、平台分支有单测，但**没有真正执行过**（这台机器没装 WSL，也没有 Linux 环境）。真要上 Linux，第一步先跑 `python bootstrap_env.py --verify`。

### J. 前端

- **取消（已做，2026-11-18）**：服务端新增 `{"req":"cancel"}`，在**取 LOCK 之前**处理，所以能立刻生效而不是排在长任务后面。渲染循环逐句检查标记，取消后停在当前句、已合成的部分保留。插件侧注册了 `POST /api/dsh-tts/cancel.json` 转发给它；客户端合成中显示"取消"按钮。实测 30 秒的渲染在 6.8 秒停住。
- **进度（部分）**：状态圆点在有任务时变成"合成中 · N 秒"，每 2 秒刷新。**没有真正的进度百分比**——服务端不知道总时长，只能给已用时间。
- **修正一个报告 bug**：原来 health 用 `LOCK.locked()` 判断忙，而用 POST 调 health 时它自己正持着锁，会永远报 busy。改成看"当前记录的请求"，GET/POST 都准。
- **工作台面板（已做，2026-11-18）**：右侧边栏新增「配音工作台」标签，三页——任务（真实进度 `第 N/M 句` + 取消 + 休眠倒计时）、历史（workDir 产物列表，可试听/下载）、音色库（试听/改名/删除/用描述新建）。
- **进度是真的**：服务端 `synth_sentences` 逐句更新 `STATE["progress"]`，`/health` 在忙时带出，请求结束（含取消/异常）在 `finally` 里清掉。
- **挂载方式**：`sidebar.right.pane.tab`（标签体）+ `sidebar.right.pane.tab.title` + `sidebar.right.tab.guide.entry`（引导页入口）。这三个 slot 名是从随包的 `dsh-client-ui-sidebar-terminal` / `-files` 里反查出来的，**没有官方文档**；实现按它们的最小用法写，三个 slot 分开 try，任一不兼容不影响另外两个。
- **⚠️ 第一版没出现引导页卡片，根因**：只往 slot 里注册了内容，**没向 `sidebarRightTabs` 注册标签类型**。
  右侧边栏的引导页条目是从标签注册表的 `guide` 数组里长出来的（`definition.guide ?? []`），slot 只负责渲染。正确顺序：
  1. `ctx.sidebarRightTabs.register({ id, kind, title(), guide: [{ id, order, title(), description() }] })`
  2. 再用**同一个 id 当 key** 注册 `sidebar.right.pane.tab` 与 `sidebar.right.pane.tab.title`
  3. 引导页卡片由默认 EntryBox 渲染，点它走 `tab.actions.openTab(kind)`——不需要自己写卡片
- **⚠️ 仍然没有视觉验收**：面板代码过了语法检查；路由链路 8 项测试、客户端注册逻辑 14 项测试（`test_client_wiring.mjs`，用假 window 加载客户端模块）；界面本身没人点过。
- **查看不启动服务（2026-11-18）**：历史与音色库的读取改成插件端直接读文件系统（`scanOutputs` / `readBankIndex`），不再 `ensureService`。实测服务停着时两次读取共 4ms、返回真实数据，且读完服务仍停着。只有写操作（改名/删除/新建）和配音本身才会拉起服务。
- **页面卡在「正在连接服务…」（2026-11-18 已修）**：HTML 是嵌在 JS 模板字符串里的，页面脚本里写了单反斜杠 + n，模板字符串求值时变成真换行，把字符串字面量截断 → 整个脚本语法错误 → 渲染函数从未执行。修法是在插件源码里写双反斜杠。
- **页面已拆成独立文件 `server/studio.html`（2026-11-18）**：不再嵌在 JS 模板字符串里，服务端按请求现读。好处：① 彻底没有转义问题 ② 改 HTML 不用动 JS ③ **改完刷新即生效，不用重启 DSH**（已验证）。`lib/index.js` 从 1724 行降到 1440 行。
- **新增 `test_studio_page.mjs`**：把服务端返回的脚本抽出来，① `new Function` 解析（只查语法不执行）② 用假 DOM 真跑一遍，断言「正在连接服务…」会被替换、视图区有内容。这类坑以后能自动发现。
- **批量队列（2026-11-18）**：`lib/queue.js`（纯调度，可单测）+ 工作台「队列」页。串行执行，任务调用的是同一个 `voiceover` 工具（所以 BUSY 互斥、取消、分行产物全部复用）。支持 暂停/继续/停止当前/重试/删除/清空。**队列只在内存里，重启 DSH 会清空**——这是刻意的：不落盘就不用处理崩溃后残留的半截状态。测试：`test_queue.mjs` 20 项 + 路由与真跑一条的集成测试 11 项。
- **队列页显示 HTTP 404（2026-11-18 已修）**：页面成了文件后是**热更新**的，而路由要重启 DSH 才有——页面先用上了新接口，插件还是旧的，直接 404。改法：status 里加 `apiVersion: 2`，页面拿自己的 `NEED_API` 对比，不一致就在顶部提示「页面比插件新，请重启 DSH」；`api()` 对 404 也给成人话；队列轮询遇到不存在的接口不再静默吞掉。
- **队列支持 PR 任务（2026-11-18）**：一条 PR 任务 = **队列里一条**，内部逐段合成并回报「第 N/M 段 · 编号」。为什么不是每段一条：时间轴工具要一次性产出全片 SRT 和对账表，拆开就没有"整片"概念了。预检不过时工具返回 `stage:'blocked'`，队列认这个状态并标成**失败**（不是完成），避免白白烧 GPU。实测：3 段样例跑通，产物 wav+mp3+全片 srt+csv 共 4 个。
- **队列任务不再出候选（2026-11-18 已修）**：队列调 voiceover 时没传 `mode`，默认 `auto`，而 `auto` 遇到描述型音色会转成 `preview`——于是"跑一段配音"变成"出 3 个候选、每个都进音色库，却没有全长产物"。现在队列强制 `mode='render'`。实测：描述型音色跑完出 mp3+srt（6.5 秒音频），音色库条目数 0→0。
- **产物列表过滤分片（2026-11-18）**：分批留下的 `<stem>-pN.*` 是**续跑依据，不能删**（先删过一次，`test_chunking` 里"重跑复用已完成批次"当场挂了 3 项）。改为在 `scanOutputs` 里过滤，文件留在磁盘、列表里不出现。
- **长文案现在也能重录拼回**：`synthStaged` 会把各分片的 `bounds.json` 按采样点偏移合并成成品的 `bounds.json`（实测 14 句、首句从 0、末句到结尾、起点单调）。之前长文案没有成品 bounds，`voiceover_retakes` 的 `full` 拼回会直接报"没有句子边界文件"。
- **多语言（2026-11-18）**：支持 zh/en/ja。语言贯穿断句（英文 `.!?` + 空格，避开小数/缩写）、语速估算（4.5 / 5.0 / 12 字符每秒）、ASR 质检、强制对齐与断词（英文按空格、中文 jieba）。实测：英文 3 句 → 3 条字幕 + ASR 质检 1.0；日文 3 句 → 3 条。
- **翻译（2026-11-18）**：本机 NLLB-200-distilled-600M（CPU，2.48G），`{req:"translate"}` 六向互译。实测 zh→en/ja、en→zh/ja、ja→zh 全部正确，模型加载 2 秒、单句 0.6–6.5 秒。
- **踩到一个空格 bug**：插件切句用「消费空白」的正则，拼回请求时把英文句号后的空格吞了 → 服务端看到 "Good morning.This is..." 再也切不开，字幕合成 1 条。改成切分后补回尾随空格。
- **nagisa（Windows 缺件）已经不再只是"挡住导入"（2026-11-18 修）**：原做法塞的是返回 `[]` 的假模块，而 qwen-asr 的**日文强制对齐**会调用 `nagisa.tagging(text).words` → 直接报 `'list' object has no attribute 'words'`。现在换成 `server/vendor/nagisa.py`（CJK 逐字 + 拉丁按词的替身），`ensure_nagisa()` 在加载 ASR/对齐器前统一安装，`bootstrap_env.py` 的探测也用同一个文件。实测：日文对齐从"直接报错"变成 19 个条目、时间落在 3.38 秒音频内；日文 ASR 一直正常（不依赖 nagisa）。
- **日文字幕断行（2026-11-18）**：日文没有空格、jieba 也帮不上，原先按字数硬切会切出「おはようございま / す。」。现在断点放在助词（はがをにでとものへやねよかな）与标点之后。实测同一段 3 句 → 3 条干净字幕。
- 仍然没有：波形预览、非 web 界面适配、队列持久化。

### K. 测试与清理

- 现有测试：`selftest.mjs`、`test_parsers.mjs`、`test_retakes.mjs`、`test_timeline_run.mjs`、`test_timeline_tool.mjs`。
- **没有 CI，没有回归基线**；XML 解析只在自造 fixture + 一个真实项目上验证过。
- `scripts/` 下原有 **85 个**文件，其中一次性调试脚本（`dump_*.py`、`patch_*.py`、`run_*.mjs`、`render_*.py`）**已归档到 `scripts/one-off/`（72 个）**，根上只留安装、测试、音色库维护，以及 `md_to_docx.py`（Markdown → Word 生成器），**建议归档到 `scripts/one-off/` 或删除**，只留 `install.mjs`、`selftest.mjs`、`test_*.mjs`、`rename_bank.py`、`set_voice_flags.py`。

### L. 代码残留

- `server/tts_server.py` 里 `nasality()` 与 takes 循环仍在（默认不触发），已被证伪，建议删除或标注。
- `synth_passage()`（整段单次合成）保留但未使用。

---

## 十、接手后的第一件事（验证清单）

```bash
# 1. 服务能起
python server/tts_server.py server/config.06b.json &
curl -s http://127.0.0.1:17322/health     # 应返回 ok:true

# 2. 十秒短句能出声（不需要 DSH）
curl -s -X POST http://127.0.0.1:17322/ -H "Content-Type: application/json" \
  -d '{"req":"say","text":"测试一下。","kind":"custom","voice":{"speaker":"Dylan"},"stem":"t"}'

# 3. 插件装了没
ls ~/.dsh/profiles/desktop/node_modules/dsh-tts    # 应是指向 E:/<工作区>/dsh-tts 的 junction

# 4. 工具在不在（重启 DSH 后）
#    应能看到 voiceover / voiceover_timeline / voiceover_retakes 三个工具
```

**注意事项**：
- 服务端改动（`tts_server.py`）**下次 spawn 生效**，不用重启 DSH；插件改动（`lib/*.js`）**必须重启 DSH**。
- 停服务只用 HTTP `{"req":"shutdown"}`，`taskkill` 常因权限失败并留下僵尸进程。
- 沙箱内加载不了 CUDA/cffi 动态库，服务必须由宿主进程拉起或命令走完整权限。

---

## 十一、文件清单与清理建议

| 路径 | 处置 |
| --- | --- |
| `lib/*.js` | 核心，保留 |
| `server/tts_server.py` | 核心，保留 |
| `cordis.patch.yml` | 唯一需要按机器改的文件 |
| `scripts/install.mjs`、`一键安装.cmd`、`一键卸载.cmd` | 保留 |
| `scripts/selftest.mjs`、`test_*.mjs` | 保留（但无 CI） |
| `scripts/rename_bank.py`、`set_voice_flags.py`、`fix_bank.py`、`show_bank.py` | 保留（音色库维护） |
| `scripts/md_to_docx.py` | 保留：Markdown → Word 转换，本交接文档就是它生成的 |
| `scripts/one-off/`（72 个） | 一次性调试脚本，**已归档**；确认无用后可整目录删除 |
| `README.md` | 面向使用者，保留 |
| `HANDOVER.md` | 本文 |

---

## 十二、关键术语

| 术语 | 含义 |
| --- | --- |
| 紧裁 | 每段音频两端只留 25ms 静音，防止拼接处出现"数字静音" |
| 交叠 | 相邻段交叉淡化 10ms；**仅在空隙 >120ms 时触发**，避免"赶" |
| 数字静音 | 采样值恒为 0 的区间（-180 dB），是拼接塞静音造成的，不是模型输出 |
| 反听字幕 | 用 ASR 把原片人声转成字幕 |
| picks.json | 逐句选版记录 |
| 音色库 | `<workDir>/voicebank/index.json`，候选音色自动入库 |

---

## 十三、接手第一批修复（2026-11-17）

背景：上一版把"897 字超时"记成已处置，实际只修在时间轴工具，主工具 `voiceover` 仍是整段单请求。本批只动这一条线，**没碰拼接参数、没碰模型路线**。

| 改动 | 位置 | 说明 |
| --- | --- | --- |
| 长文案分批 | `lib/synth.js`（新）+ `lib/index.js` | `voiceover` 与多角色 `timeline` 数组都按 ≤300 字切分（先按句，单句超长才硬切），拼回后字幕按累计时长偏移 |
| 分片续跑 | `lib/synth.js` | 每片完成后写 `<stem>-pN.json` 旁注；重跑同一文案直接复用，改一个字只重做受影响的那片 |
| 默认文件名改为文案哈希 | `lib/index.js` | 不传 `title` 时 stem 是 `vo-<hash>`，同样的文案再跑一次自动续跑 |
| 超时可恢复 | `lib/index.js` | 重试白名单补 `HeadersTimeout` / `UND_ERR_HEADERS_TIMEOUT` / `ECONNRESET` / `EPIPE`；配合续跑，一次超时不再白跑五分钟 |
| 拼接不再依赖 ffmpeg | `lib/synth.js` | 服务端固定输出 16-bit 单声道 PCM，分片改为字节级直拼（无损，且绕开 Windows 路径在 concat 列表里的转义问题）；格式不一致时自动回退 ffmpeg |
| 重录工具描述纠正 | `lib/index.js` | 删掉"按需重拼整段"——它从来只写 `chosen-N.wav` + `picks.json`，照原描述汇报会向用户谎报"已拼回" |
| 新增回归测试 | `scripts/test_chunking.mjs` | 不依赖 GPU、不发 HTTP、不需要 ffmpeg，秒级跑完：切分 / 续跑 / 字幕偏移 / 格式回退全覆盖 |
| 音色库去噪 | `server/tts_server.py` + `lib/index.js` | 全长渲染默认**不再自动入库**（要存传 `bank=true`）；入库时按音色指纹去重，同一音色不再堆出 `-2/-3/-4`。出候选时仍然各自保留——那里本该是 N 个不同的音，去重会把挑音色的流程合并掉 |
| 句子级拼回 | `server/tts_server.py` + `lib/index.js` | `say` 现在额外写 `<stem>.bounds.json`（每句在成品里的**采样**起止点）；新增 `splice` 端点按样本区间替换某一句，电平对齐到被替换区间，字幕与边界按实际差值顺延。`voiceover_retakes` 传 `use=N`+`full=<整段>` 即调用。老音频没 bounds 会明确拒绝并说明原因 |
| 错误码分级 | `server/tts_server.py` | 预期内的拒绝（缺文件 / 序号越界 / 采样率不符）返回 400 + 人话原因，不再和"服务真崩了"一起变成裸 500 |
| 新增拼接回归 | `scripts/test_splice.py` | 自己拉起服务、用合成正弦波当素材，不需要 GPU、不需要模型；覆盖替换、时长、字幕顺延、以及三条拒绝路径 |
| 停顿不填纯零 | `server/tts_server.py` | 规整停顿需要"补"时，原来补的是纯 0（实测 -240 dBFS）。模型自己的间隙是 -60~-66 dBFS，于是插入段听起来像"断了一下"。现在改为按两端实测底噪生成同电平柔和噪声（轻度低通 + 8ms 淡入淡出），实测填到 -66.5 dBFS，与自然间隙一致 |
| 强制对齐 | `server/tts_server.py` + `lib/synth.js` + `lib/index.js` | 新增 `align` 端点与 `voiceover({align:true})`；字级时间经 `bindAlignedText`（补回被丢的标点）→ `groupAlignedCues`（按标点/长度/停顿断行）生成字幕。含两个单位坑的修正。测试：`test_align.mjs`（14 项，免模型）+ `test_align_model.py`（端到端） |
| 反听字幕接线 | `lib/index.js` + `lib/plan.js` + `lib/clips.js` + `server/tts_server.py` | `04S/` + 正文留空 = 反听：按标记区间切原片音频 → ASR 转写 → 强制对齐 → 字级字幕，自动并入全片 SRT（按入点偏移）。对齐不可用时退回按字数分配。`plan` 阶段把它标成"字幕（反听）"并跳过时长估算 |
| picks.json 换键 | `lib/picks.js`（新）+ `lib/index.js` | 键从"句序"改成"句序@文本hash@音色标签"，带历史与 current 指针；旧文件自动迁移。出多版时会提示"这句在这个音色下上次选的是第几版"。测试：`test_picks.mjs`（20 项） |
| 并发与生命周期 | `lib/guard.js`（新）+ `lib/index.js` + `server/tts_server.py` | 工具级互斥（忙则快速失败、可配等待）、`/health` 暴露 busy、修掉并发 spawn 竞态、启动即退出改为当场报错。测试：`test_guard.mjs`（13 项）+ 真实并发实测 |
| 前端取消与进度 | `server/tts_server.py` + `lib/index.js` + `lib/client.js` | 服务端 cancel（取锁前处理、逐句检查）；插件注册 POST 取消路由；状态点显示"合成中 N 秒"+取消按钮。顺带修掉 health 在持锁时永远报 busy 的问题 |
| 时间轴格式 | `lib/timeline.js` + `lib/plan.js` | 非目标格式给出可照做的报错（FCPXML/EDL/非 XML 分别提示）；读 `<timecode>` 并在预检提示偏移风险；标记超出序列时长、标记后缀与文案模式冲突都会告警。测试：`test_timeline_formats.mjs`（20 项） |
| 跨平台收敛 | `lib/platform.js`（新）+ `scripts/install.mjs` + `一键安装.sh` | 安装按平台选 junction / 符号链接（并修掉卸载时 POSIX 会删到目标目录的坑）、ffmpeg concat 路径按平台转义、编码固定注入。平台分支有单测（`test_platform.mjs` 12 项），但 Linux 实际运行仍未验证 |
| 环境可复现 | `requirements/` + `bootstrap_env.py` + `models.manifest.json` | 38 个包逐包 pin；Windows/Linux × NVIDIA/AMD/CPU 的矩阵与真实约束（**Windows+AMD 没有 ROCm wheel，只能退 CPU**）；transformers 冲突做成"先试 4.57.6、自检不过回退 4.57.3"；模型只做清单与字节数校验，不自动下 11G。`sox` 桩从依赖目录收进 `server/vendor/`——它原来不在版本库里，是"换机器复现不了"的一环 |

仍然没做（继续留在第九节）：真正的切片拼回（A）、`picks.json` 键（B）、反听字幕接线（C）、强制对齐（E）、`requirements.txt`（F）。

**已知副作用**
- 长文案会在产物目录留下 `<stem>-pN.wav/.srt/.json`，这是续跑用的缓存，删掉不影响成品。
- `HANDOVER.docx` / `HANDOVER.pdf` 本次未重新生成（沙箱内起不了子进程跑 `md_to_docx.py`），需要时在宿主上重跑一次。

---

### 归档记录

- 2026-11-17：`scripts/` 下 85 个文件，保留 13 个（安装 / 测试 / fixtures / 音色库维护 / md_to_docx.py），其余 **72 个归档到 `scripts/one-off/`**。
- 归档后回归：`test_parsers.mjs`、`test_timeline_tool.mjs` 均通过（脚本只依赖 `lib/*.js` 与 `fixtures/`，路径未受影响）。

*文档基于插件 v0.2.0（`package.json`）与 2026-11 的实机状态整理。*
