#!/usr/bin/env python3
"""静音判据的回归测试：裁切与接缝测量必须用同一把尺子。

背景：原来 trim_silence 用「峰值 × 0.5%」的逐采样门限，_edge_silence 用
「绝对值 0.01」。当一段音频的底噪正好落在两者之间（克隆音色就是这样），
裁切看不见它、量接缝却看得见，于是半秒多的低电平尾巴被原样拼进成品。

这个测试造出那种"底噪居中"的片段，验证两件事：
  1. trim_silence 能把这种尾巴裁掉；
  2. trim 之后 _edge_silence 量到的残余，和保留的边距对得上。

不需要 GPU、不需要服务、不需要模型：只是 numpy 数组。
"""
import importlib.util
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
SERVER = HERE.parent / "server" / "tts_server.py"
SR = 24000

fail = 0


def ok(cond, label, extra=""):
    global fail
    print(("  ok   " if cond else "  FAIL ") + label + ((" -> " + str(extra)) if not cond else ""))
    if not cond:
        fail += 1


def load_module():
    spec = importlib.util.spec_from_file_location("tts_server", SERVER)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["tts_server"] = mod
    spec.loader.exec_module(mod)
    return mod


def make_clip(noise_ratio: float, tail_sec: float):
    """1 秒 220Hz 正弦 + 一段低电平底噪尾巴。noise_ratio 是底噪相对峰值的比例。"""
    t = np.arange(int(1.0 * SR)) / SR
    peak = 0.5
    voice = (peak * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    tail = (peak * noise_ratio * np.random.RandomState(0).randn(int(tail_sec * SR))).astype(np.float32)
    return np.concatenate([voice, tail])


def main() -> int:
    ts = load_module()

    print("[1] 底噪居中（0.7% 峰值，落在旧的两把尺子之间）")
    clip = make_clip(0.007, 0.6)
    out = ts.trim_silence(clip, SR)
    kept = (len(clip) - len(out)) / SR
    ok(kept > 0.5, "0.6 秒的底噪尾巴被裁掉（旧判据会原样保留）", round(kept, 3))
    ok(len(out) / SR < 1.15, "裁完长度合理", round(len(out) / SR, 3))
    head, tail = ts._edge_silence(out, SR)
    ok(tail <= 0.06, "裁完的尾部残余 <= 60ms（keep_tail=25ms + 一个帧长）", round(tail, 4))
    ok(head <= 0.06, "头部残余同样受控", round(head, 4))

    print("[2] 两把尺子必须给出同一个结论")
    # 裁之前量：_edge_silence 应该看到那段尾巴确实是静音
    _, raw_tail = ts._edge_silence(clip, SR)
    ok(raw_tail > 0.5, "裁之前量得到 0.6 秒尾巴", round(raw_tail, 3))
    ok(abs(raw_tail - kept) < 0.08, "「量到的静音」和「裁掉的长度」基本相等",
       {"measured": round(raw_tail, 3), "removed": round(kept, 3)})

    print("[3] 干净的音频不能被误裁（防止矫枉过正）")
    clean = make_clip(1e-6, 0.0)
    clean_out = ts.trim_silence(clean, SR)
    lost = (len(clean) - len(clean_out)) / SR
    ok(lost <= 0.05, "没有尾巴时几乎不裁", round(lost, 4))

    print("[4] 慢起音不能被削掉")
    # 80ms 的渐入，模拟克隆音色的起音；裁切后仍应保留可闻起点
    ramp = np.linspace(0.0, 0.5, int(0.08 * SR)).astype(np.float32)
    body = (0.5 * np.sin(2 * np.pi * 220 * np.arange(int(0.6 * SR)) / SR)).astype(np.float32)
    att = np.concatenate([ramp, body]).astype(np.float32)
    trimmed = ts.trim_silence(att, SR)
    lead = (len(att) - len(trimmed)) / SR if len(trimmed) < len(att) else 0.0
    ok(abs(len(trimmed) - len(att)) / SR <= 0.05, "慢起音片段几乎不被裁", round(lead, 4))

    print()
    print("全部通过" if fail == 0 else "%d 项失败" % fail)
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
