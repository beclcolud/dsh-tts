#!/usr/bin/env python3
"""定位"爆麦/咔哒"是生成时就有，还是处理时引入的。

思路：同一段文案渲染三种形态，逐个量硬指标——
  1. single  单句、不裁切、不拼接：完全没经过我们的后处理，纯模型输出
  2. raw     整段、不裁切、不填充（seam=current）：只做了拼接
  3. donor   正常成品（seam=target + 供体填充）

指标：
  peak / RMS           —— 电平，判断是否被推爆
  clipped              —— 采样贴到 ±32767 的个数（真削波）
  max jump             —— 相邻采样最大跳变，及其时间点（爆音的典型特征）
  接缝附近跳变         —— 判断跳变是不是发生在拼接处

用法：python scripts/diagnose_clicks.py [--pauses '{...}'] [--voice 新闻联播音色]
"""
import argparse
import json
import subprocess
import sys
import tempfile
import time
import urllib.request
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PORT = 17393
URL = "http://127.0.0.1:%d/" % PORT
SR_EXPECT = 24000

TEXT = (
    "清早的菜市场是最热闹的地方。摊主一边摆菜，一边跟熟客打招呼；青菜、豆腐、鲜鱼，摊子挨着摊子。"
    "有人为了两毛钱讲价，也有人二话不说就付了钱：这里的规矩，从来不是写在牌子上的。"
)


def make_workdir(prefix: str) -> Path:
    base = Path(tempfile.gettempdir())
    try:
        base.resolve().relative_to(Path.cwd().resolve())
        base = Path.cwd().parent / "_tmp"
        base.mkdir(parents=True, exist_ok=True)
    except ValueError:
        pass
    return Path(tempfile.mkdtemp(prefix=prefix, dir=str(base)))


def call(req, **body):
    data = json.dumps({"req": req, **body}).encode()
    r = urllib.request.Request(URL, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=300) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        raise SystemExit("服务返回 %d：%s" % (exc.code, exc.read().decode("utf-8", "replace")[:300]))


def read_wav(path: Path):
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32767.0, sr


def analyse(name: str, path: Path, seams_ms=()):
    a, sr = read_wav(path)
    if len(a) == 0:
        print("  %-8s 空文件" % name)
        return
    peak = float(np.max(np.abs(a)))
    rms = float(np.sqrt(np.mean(a ** 2)))
    clipped = int(np.sum(np.abs(a) >= 0.999))
    d = np.abs(np.diff(a))
    jumps = np.argsort(d)[::-1][:5]
    seam_hits = 0
    for j in jumps:
        t_ms = j * 1000.0 / sr
        if any(abs(t_ms - s) <= 50 for s in seams_ms):
            seam_hits += 1
    print("  %-8s %6.2fs  peak %5.1f dBFS  rms %5.1f dBFS  削波 %d 个  max跳变 %.4f @ %.2fs"
          % (name, len(a) / sr, 20 * np.log10(peak + 1e-12), 20 * np.log10(rms + 1e-12),
             clipped, float(d.max()), float(jumps[0]) / sr))
    if len(jumps) > 1:
        times = ["%.2f" % (j / sr) for j in jumps]
        print("           top5 跳变时刻(s): %s ；其中落在接缝 ±50ms 内的: %d/5"
              % (", ".join(times), seam_hits))
    return {"peak_db": round(20 * np.log10(peak + 1e-12), 1),
            "rms_db": round(20 * np.log10(rms + 1e-12), 1),
            "clipped": clipped, "max_jump": round(float(d.max()), 4),
            "jump_times": [round(float(j) / sr, 2) for j in jumps]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models-dir", default=str(ROOT.parent / "models"))
    ap.add_argument("--libs", default=str(ROOT.parent / "_tts_probe" / "pylibs"))
    ap.add_argument("--bank-dir", default=str(ROOT.parent / "配音" / "voicebank"))
    ap.add_argument("--voice", default="新闻联播音色")
    ap.add_argument("--pauses", default='{"。": 260, "；": 160}')
    ap.add_argument("--peak-ceilings", default="0.95,0.70",
                    help="逗号分隔的峰值上限，逐个渲染同一段做对比")
    ap.add_argument("--export-dir", default=str(ROOT.parent / "配音" / "_diag"))
    args = ap.parse_args()

    work = make_workdir("dsh-tts-diag-")
    bank = Path(args.bank_dir) / "index.json"
    if bank.exists():
        (work / "voicebank").mkdir(parents=True, exist_ok=True)
        (work / "voicebank" / "index.json").write_bytes(bank.read_bytes())

    cfg = {
        "libs": args.libs,
        "work_dir": str(work),
        "models": {k: str(Path(args.models_dir) / v) for k, v in {
            "custom": "Qwen3-TTS-0.6B-CustomVoice",
            "base": "Qwen3-TTS-0.6B-Base",
            "asr": "Qwen3-ASR-0.6B",
            "design": "Qwen3-TTS-1.7B-VoiceDesign",
        }.items()},
        "port": PORT,
        "idle_shutdown_ms": 0,
    }
    cfg_path = work / "cfg.json"
    cfg_path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    log = open(work / "server.log", "w", encoding="utf-8")
    proc = subprocess.Popen([sys.executable, str(ROOT / "server" / "tts_server.py"), str(cfg_path)],
                            stdout=log, stderr=log)
    try:
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                urllib.request.urlopen(URL + "health", timeout=2).read()
                break
            except Exception:
                time.sleep(1)
        else:
            print("服务没起来：" + (work / "server.log").read_text(encoding="utf-8", errors="replace")[-800:])
            return 1

        bank_entries = call("bank_list").get("entries", {})
        if args.voice in bank_entries:
            kind, voice = bank_entries[args.voice]["kind"], bank_entries[args.voice]["voice"]
        else:
            kind, voice = "custom", {"speaker": args.voice}
        print("音色：%s（kind=%s）" % (args.voice, kind))
        print()

        results = {}
        first_sentence = TEXT.split("。")[0] + "。"

        print("[1] 单句、不裁切、不拼接（纯模型输出）")
        r1 = call("say", text=first_sentence, kind=kind, voice=voice, stem="d1",
                  out_dir=str(work), trim=False, seam="current")
        results["single"] = analyse("single", Path(r1["wav"]))

        print("[2] 整段、不裁切、不填充（只拼接）")
        r2 = call("say", text=TEXT, kind=kind, voice=voice, stem="d2",
                  out_dir=str(work), trim=False, seam="current")
        b2 = json.loads(Path(r2["bounds"]).read_text(encoding="utf-8"))
        seam_ms2 = [s["start"] * 1000.0 / b2["sr"] for s in b2["sentences"][1:]]
        results["raw"] = analyse("raw", Path(r2["wav"]), seam_ms2)

        export = Path(args.export_dir)
        export.mkdir(parents=True, exist_ok=True)
        for k, ceil in enumerate([c.strip() for c in args.peak_ceilings.split(",") if c.strip()]):
            label = "cell%s" % ceil
            print("[3.%d] 成品（seam=target + 供体填充，峰值上限 %s）" % (k + 1, ceil))
            r3 = call("say", text=TEXT, kind=kind, voice=voice, stem="d3-" + ceil.replace(".", ""),
                      out_dir=str(work), seam="target", seam_target_ms=json.loads(args.pauses),
                      peak_ceiling=float(ceil))
            b3 = json.loads(Path(r3["bounds"]).read_text(encoding="utf-8"))
            seam_ms3 = [s["start"] * 1000.0 / b3["sr"] for s in b3["sentences"][1:]]
            stat = analyse("ceil=" + ceil, Path(r3["wav"]), seam_ms3)
            results[label] = stat
            if k == 0:
                results["donor"] = stat
            seams = json.loads(Path(r3["seams"]).read_text(encoding="utf-8"))["seams"]
            print("           接缝填充方式: %s" % [s.get("fill") for s in seams])
            base = "峰值上限%s" % ceil.replace(".", "")
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", r3["wav"], "-c:a", "libmp3lame",
                            "-b:a", "192k", str(export / (base + ".mp3"))], check=False)
            print("           导出: %s" % (export / (base + ".mp3")))

        print()
        print("=== 判断 ===")
        s1, s2, s3 = results.get("single"), results.get("raw"), results.get("donor")
        if s1 and s1["max_jump"] > 0.3:
            print("  单句未处理就有 %.3f 的跳变 → 问题在**模型生成**，不是后处理" % s1["max_jump"])
        if s2 and s3 and s3["max_jump"] > s2["max_jump"] * 1.5:
            print("  成品跳变(%.3f) 明显大于未填充的拼接(%.3f) → 问题**在处理环节**"
                  % (s3["max_jump"], s2["max_jump"]))
        elif s2 and s3:
            print("  成品跳变(%.3f) 与未填充拼接(%.3f) 相当 → 后处理没有放大跳变"
                  % (s3["max_jump"], s2["max_jump"]))
        if s3 and s3["clipped"] > 0:
            print("  成品里有 %d 个贴顶采样 → 存在真削波" % s3["clipped"])
    finally:
        try:
            call("shutdown")
        except Exception:
            pass
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        log.close()
    print()
    print("工作目录（音频保留，可复听）：%s" % work)
    return 0


if __name__ == "__main__":
    sys.exit(main())
