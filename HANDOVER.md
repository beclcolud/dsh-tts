# dsh-tts 插件交接文档

> 交接范围：**只讲插件本身**。项目（vlog）制作过程只保留"与插件工作直接相关"的部分——即插件在真实项目里暴露了什么缺陷、怎么修的、还差什么。
> 读者：接下来维护这个插件的人。读完应当能在新机器上装起来、跑通三个工具、并知道哪些坑还没填。

---

## 一、当前状态一览

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 文案 → 配音 + 逐句字幕 + 成片 | ✅ 可用 | 0.6B CustomVoice + 克隆音色，实测 5 分钟片可用 |
| 按 PR 时间轴分段配音 | ⚠️ 可用但只验证过一种格式 | 只吃 PR 导出的 FCP XML（xmeml）；其他剪辑软件未支持 |
| 句子级重录 | ⚠️ 半成品 | 能出多版、能记录选择，**不能自动拼回原段** |
| 原片人声反听生成字幕 | ⚠️ 能力有、入口没有 | 服务端 `asr_subs` + `lib/clips.js` 已具备，未接进工具流程 |
| 本地服务常驻 / 空闲自退 | ✅ 可用 | 端口 17321，仅监听 127.0.0.1，无鉴权 |
| Web 端播放卡片 + 状态圆点 | ✅ 可用 | 5 秒轮询；服务重启瞬间会闪灰 |
| 1.7B 模型路线 | ❌ 已放弃 | 节奏失控、耗时不可控，见第八节 |
| 多角色对白（一句一个音色） | ⚠️ 仅 `voiceover` 的 timeline 参数支持 | 时间轴工具里没有 |

代码规模：**2233 行**（JS 1469 + Python 764），无第三方运行时依赖（ffmpeg 除外，需在 PATH）。

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
- **建议**：以 `(文本 hash, 句子序号)` 为键，附音色名与时间戳。

### C. 原片人声反听字幕没接进工具

- **现状**：服务端 `asr_subs` 可用；`lib/clips.js` 能从 XML 取媒体片段并按区间去重；但**工具里没有入口**，这次是在 tools 之外用 `scripts/one-off/build_seg_audio.mjs` + 手工 curl + `scripts/one-off/merge_srt.py` 拼起来的。
- **为什么没接**：当时赶交付，先手工跑通再说。
- **建议**：在 `voiceover_timeline` 的 run 流程里，对 `mode=subtitle` 且文案为空的段，自动走 `clips → ffmpeg 切片 → asr_subs → 偏移合并`。

### D. 时间轴工具只支持一种输入格式

- 只吃 PR 导出的 FCP XML（xmeml）。达芬奇、FCP 原生、剪映、EDL 均未支持（工具描述里已写明"先只做 PR XML"）。
- 假定序列起点为 0（未读 `<timecode>`）——真实项目恰好从 0 开始，**换项目要注意**。
- 标记名只取数字，`03v/` 的后缀不参与判断；标记后缀与文案后缀冲突时**无告警**。
- 只出 SRT，不出 ASS/TTML，也不写回 PR；不生成 `.prproj`。

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

- 无守护进程：服务崩了要等下一次工具调用把它拉起；端口被占时能抢占（会先发 shutdown）。
- 单进程单卡，切换模型 5–8 秒，期间请求排队。
- 无并发控制：两个工具同时调用会串行，长任务期间第二个请求会等很久。
- 无鉴权（仅监听 127.0.0.1，风险可接受，但别改绑定地址）。

### I. Windows 专用

- junction 安装、`taskkill`、路径分隔符、GBK 控制台编码问题（脚本里多次用 `PYTHONUTF8=1` 绕开）都是 Windows 特有，未做跨平台。

### J. 前端只有两个点

- 播放卡片 + 状态圆点。没有进度条、没有取消按钮、没有历史列表。
- 只与 web 端 slot 对接，非 web 界面不显示。

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
