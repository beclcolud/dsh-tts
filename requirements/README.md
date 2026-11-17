# 依赖与环境矩阵

这个目录回答一个问题：**换一台机器，怎么把这套 TTS 环境装起来。**

结论先说：真正麻烦的不是包多，是有三处**上游本身装不干净**的地方，必须知道内情。

---

## 一、三层依赖，别混在一起

| 层 | 内容 | 谁负责 |
| --- | --- | --- |
| 宿主层 | torch / torchaudio / torchvision / numpy / scipy / sentencepiece / einops | 宿主 Python 环境（本机是 ComfyUI 便携包） |
| 我们这层 | `base.txt` 里的 38 个包 | `bootstrap_env.py --install` |
| 模型 | 4 个 safetensors 目录，共约 10G | 只做清单与校验，不自动下载 |

**为什么宿主层不能由我们装**：这些包带着 CUDA 运行时和二进制 ABI，再装一份到依赖目录会互相遮蔽，出现"一个进程里两套 torch"的崩溃。`host-provided.txt` 只用于探测和报错，不要拿去 `pip install`。

---

## 二、三处上游装不干净的地方

### 1. transformers 的版本冲突（硬冲突，无解）

- `qwen-tts 0.1.1` 声明 `transformers==4.57.3`
- `qwen-asr 0.0.6` 声明 `transformers==4.57.6`

两者互斥，**任何正常的 pip 解析都装不出一个满足两边的组合**。

本机用的是 A 方案（4.57.3 的代码 + 一份 4.57.6 的假元数据骗过 pip 检查），实测 TTS 出声、ASR 回读相似度 0.989，两条链路都正常。

B 方案（真装 4.57.6）未验证。`bootstrap_env.py --transformers auto` 的策略是：

1. 先装 B，跑自检
2. 自检不过就退回 A，并补上假元数据

对应文件：`transformers-4.57.3.txt` / `transformers-4.57.6.txt`。

### 2. nagisa 装得上但导入必崩

`nagisa 0.2.11` 是 `qwen-asr` 的依赖，但它要 `dynet_config`——那是编译期才有的东西，Windows 上没有。装上之后 `import nagisa` 直接 `ModuleNotFoundError`。

**修法不在环境里，在服务端代码里**：`tts_server.py` 在导入 `qwen_asr` 之前，往 `sys.modules` 塞了一个只有 `tagging()` 的假 nagisa。所以：

- 环境这边：照常 `pip install nagisa==0.2.11`（满足依赖声明即可，不用它真能用）
- 复现时**不需要**额外打补丁，这段逻辑跟着代码走

### 3. sox 需要一个桩

`qwen-tts` 声明依赖 `sox`（pysox），但 pysox 需要一个真正的 `sox` 可执行文件，这里没有。它只在 25Hz VQ 路径（`Qwen3TTSTokenizerV1`）被导入，而 12Hz 模型永远不会走那条路。

所以放一个 18 行的桩就够。桩的源码现在在 `server/vendor/sox.py`（之前只存在于依赖目录里，不在版本库，换机器就丢），由 bootstrap 复制过去。

---

## 三、声明了但**不需要**的依赖

`qwen-tts` / `qwen-asr` / `audio-separator` 的战绩声明里还有这些，实际代码路径用不到，装了只会拖一堆重依赖：

| 包 | 谁声明的 | 为什么不装 |
| --- | --- | --- |
| gradio | qwen-tts / qwen-asr | 只给他们自己的网页 demo 用 |
| julius | audio-separator | 只在特定分离器路径里 |
| ml_collections | audio-separator | 同上 |
| beartype | audio-separator | 运行时类型检查，可选 |
| diffq-fixed | audio-separator（win32） | 量化，用不到 |
| onnx-weekly | audio-separator | 用的是 `onnx==1.23.2` 稳定版 |

**验证方式**：不装它们的情况下 `audio_separator` / `qwen_tts` / `qwen_asr` 三个包都能正常导入，且人声分离实测跑通过（生成了 `ref-1794805281.wav`）。

---

## 四、平台矩阵

| 平台 | GPU | 能不能跑 | 说明 |
| --- | --- | --- | --- |
| Windows | NVIDIA | ✅ 已验证 | 本机环境（ComfyUI 便携包 python 3.13.14 + torch 2.14.1+cu130） |
| Linux | NVIDIA | ✅ 支持 | 装 NVIDIA 驱动的 CUDA 版 torch |
| Linux | AMD | ⚠️ 支持 | 必须用 ROCm 版 torch，且只在 Linux 有官方 wheel |
| Windows | AMD | ⚠️ 只能 CPU | **PyTorch 没有 ROCm 的 Windows 版**，这是上游限制，不是本方案的取舍。退 CPU 能出声但很慢 |
| 任意 | 无 GPU | ⚠️ 能跑但慢 | 走 `torch-cpu.txt` |
| Apple Silicon | MPS | ❌ 不支持 | 本方案明确不覆盖 |

**Windows + AMD 这条要特别注意**：网上有些教程提 `torch-directml`，但它对新模型算子支持不全，qwen-tts 大概率跑不起来，本方案不为此背书。

---

## 五、怎么用

```bash
# 1. 只探测，什么都不改（默认）
python bootstrap_env.py

# 2. 实际安装（复用宿主已有的 torch）
python bootstrap_env.py --install --torch none

# 3. 没有 torch，自建一份（按平台自动选轮子）
python bootstrap_env.py --install --torch auto

# 4. 校验模型文件
python bootstrap_env.py --check-models --models-dir /path/to/models

# 5. 端到端自检：起服务 + 合成一句 + ASR 回读
python bootstrap_env.py --verify
```

装完之后，插件配置（`cordis.patch.yml`）里的 `pythonPath` 和 `libs` 要指向新环境。

---

## 六、pin 的版本可信吗

`base.txt` 里 38 个包全部 pin 到 2026-11-17 在真机上**实际生效**的版本，不是抄来的。生成方式是在同一进程里按 `sys.path` 顺序解析每个包真正落到哪个文件，再读它的版本 —— 所以它描述的是"这份环境到底跑了什么"，而不是"requirements 里写了什么"。
