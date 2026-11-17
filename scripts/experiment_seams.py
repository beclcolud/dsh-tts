#!/usr/bin/env python3
"""接缝 A/B 实验：现状策略 vs 按标点规整停顿。

只做对比，不改默认。跑完会生成两条 mp3 和一个对照表，用人耳判断。

    python scripts/experiment_seams.py [--out DIR]

两条音频唯一的差别就是句间停顿的处理方式：
  A current  保留 25ms 边距，空隙 >120ms 才做 10ms 交叉淡化（现有默认）
  B target   按句末标点把停顿规整到 180/140/90/70ms
"""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PORT = 17395
URL = "http://127.0.0.1:%d/" % PORT

TEXT = (
    "清早的菜市场是最热闹的地方。摊主一边摆菜，一边跟熟客打招呼；青菜、豆腐、鲜鱼，摊子挨着摊子。"
    "有人为了两毛钱讲价，也有人二话不说就付了钱：这里的规矩，从来不是写在牌子上的。"
)


def make_workdir(prefix: str) -> Path:
    """把临时目录建在系统 temp 里。

    注意：TEMP/TMP 没配置时，Python 的 tempfile 会退到**当前目录**——
    test 脚本又常从仓库根跑，于是临时目录就落进版本库了（已经发生过一次）。
    这里显式检查，一旦发现指向仓库内部就改用仓库外的 _tmp。
    """
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
        body = exc.read().decode("utf-8", "replace")
        raise SystemExit("服务返回 %d：%s" % (exc.code, body[:400]))


def silence_runs(wav: Path, min_ms=50.0, thr_ratio=0.03, boundaries=None):
    """独立测静音：不信任服务端上报的数字，直接从波形量。

    返回 (所有静音段毫秒列表, 每个句子边界处那道静音的毫秒数)。"""
    import numpy as np
    import wave
    with wave.open(str(wav), "rb") as w:
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32767.0
    win = max(2, int(0.01 * sr))
    hop = max(1, int(0.005 * sr))
    n = len(a) // hop
    rms = np.array([float(np.sqrt(np.mean(a[i * hop:i * hop + win] ** 2))) for i in range(n)])
    if len(rms) == 0:
        return [], sr
    thr = max(float(rms.max()) * thr_ratio, 1e-6)
    runs, start = [], None
    for i, v in enumerate(rms):
        if v < thr:
            if start is None:
                start = i
        else:
            if start is not None:
                runs.append((i - start) * 0.005)
                start = None
    if start is not None:
        runs.append((len(rms) - start) * 0.005)

    # 带位置重新走一遍，供"每个句子边界处的静音有多长"使用
    spans, start = [], None
    for i, v in enumerate(rms):
        if v < thr:
            if start is None:
                start = i
        else:
            if start is not None:
                spans.append((start * 0.005, (i - start) * 0.005))
                start = None
    if start is not None:
        spans.append((start * 0.005, (len(rms) - start) * 0.005))

    at_boundary = []
    for b in (boundaries or []):
        hit = next((d for (s0, d) in spans if s0 <= b <= s0 + d), None)
        at_boundary.append(round(hit * 1000) if hit is not None else 0)
    return [round(x * 1000) for x in runs if x * 1000 >= min_ms], sr, at_boundary


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=None)
    ap.add_argument("--models-dir", default=str(ROOT.parent / "models"))
    ap.add_argument("--libs", default=str(ROOT.parent / "_tts_probe" / "pylibs"))
    ap.add_argument("--voice", default="新闻联播音色", help="音色库名或预设名；不同音色的接缝表现差别很大")
    ap.add_argument("--bank-dir", default=str(ROOT.parent / "配音" / "voicebank"))
    ap.add_argument("--pauses", default=None,
                    help="覆盖停顿时长（JSON，键是句末标点），例如 {\"。\": 260}")
    args = ap.parse_args()

    work = make_workdir("dsh-tts-seam-")
    out = Path(args.out) if args.out else (ROOT.parent / "配音" / "_seam_ab")
    out.mkdir(parents=True, exist_ok=True)

    cfg = {
        "work_dir": str(work),
        "models": {k: str(Path(args.models_dir) / v) for k, v in {
            "custom": "Qwen3-TTS-0.6B-CustomVoice",
            "base": "Qwen3-TTS-0.6B-Base",
            "asr": "Qwen3-ASR-0.6B",
            "design": "Qwen3-TTS-1.7B-VoiceDesign",
        }.items()},
        "libs": str(Path(args.libs)),
        "port": PORT,
        "idle_shutdown_ms": 0,
    }
    cfg_path = work / "cfg.json"
    cfg_path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    # 实验用临时 work_dir，音色库是空的；把真实库拷进去才能按名字选音色。
    # 条目里的 ref_audio 是绝对路径，拷过来仍然有效。
    src_bank = Path(args.bank_dir) / "index.json"
    if src_bank.exists():
        (work / "voicebank").mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src_bank, work / "voicebank" / "index.json")
    else:
        print("提醒：找不到音色库 %s，只能按预设名选音色" % src_bank)

    log = open(work / "server.log", "w", encoding="utf-8")
    proc = subprocess.Popen([sys.executable, str(ROOT / "server" / "tts_server.py"), str(cfg_path)],
                            stdout=log, stderr=log)
    results = {}
    try:
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                urllib.request.urlopen(URL + "health", timeout=2).read()
                break
            except Exception:
                time.sleep(1)
        else:
            print("服务没起来，日志：" + (work / "server.log").read_text(encoding="utf-8", errors="replace")[-800:])
            return 1

        bank = call("bank_list").get("entries", {})
        if args.voice in bank:
            kind, voice = bank[args.voice]["kind"], bank[args.voice]["voice"]
            print("音色：%s（音色库，kind=%s）" % (args.voice, kind))
        else:
            kind, voice = "custom", {"speaker": args.voice}
            print("音色：%s（预设）" % args.voice)

        extra = {}
        if args.pauses:
            extra["seam_target_ms"] = json.loads(args.pauses)
            print("停顿覆盖：%s" % extra["seam_target_ms"])

        for label, seam in (("A", "current"), ("B", "target")):
            print("渲染 %s（seam=%s）..." % (label, seam), flush=True)
            r = call("say", text=TEXT, kind=kind, voice=voice,
                     stem="seam" + label, out_dir=str(work), seam=seam, **extra)
            wav = Path(r["wav"])
            bounds = json.loads(Path(r["bounds"]).read_text(encoding="utf-8"))
            starts = [s["start"] / bounds["sr"] for s in bounds["sentences"][1:]]
            runs, sr, at_b = silence_runs(wav, boundaries=starts)
            tag = "A-现状" if label == "A" else "B-按标点"
            if label == "B" and args.pauses:
                tag += "-自定义"
            mp3 = out / ("接缝%s-%s.mp3" % (tag, args.voice))
            try:
                subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(wav), "-c:a", "libmp3lame",
                                "-b:a", "192k", str(mp3)], check=True)
            except Exception as exc:
                print("  ffmpeg 失败（保留 wav）：%s" % exc)
                mp3 = wav
            results[label] = {"seam_report": json.loads(Path(r["seams"]).read_text(encoding="utf-8")),
                              "wav": str(wav), "mp3": str(mp3), "dur": r["dur"],
                              "silences": runs, "at_boundary": at_b}
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
    print("=" * 66)
    for label in ("A", "B"):
        if label not in results:
            continue
        d = results[label]
        print("%s  %s  时长 %.2fs" % (label, "现状（25ms 边距 + 120ms 才淡化）"
                                   if label == "A" else "B 按标点规整停顿", d["dur"]))
        sr = d["seam_report"]
        for k, s in enumerate(sr["seams"]):
            if s.get("target_ms"):
                how = "目标 %.0fms" % s["target_ms"]
            else:
                how = "交叠 %.1fms" % s["overlap_ms"] if s["overlap_ms"] else "未交叠（空隙没到 120ms 阈值）"
            print("    接缝%d  调整前 %5.1fms → 调整后 %5.1fms  [%s]  ← 前句结尾「%s」"
                  % (s["i"], s["before_ms"], s["after_ms"], how, s["after"]))
            print("           波形实测该边界静音: %dms" % (d["at_boundary"][k] if k < len(d["at_boundary"]) else -1))
        print("    全部静音段(ms): %s" % (d["silences"] or "无"))
        print()

    print("对照：")
    print("  A 的停顿基本是固定的几十毫秒，不看标点；B 按标点区别对待（。180 / ；140 / ，90 / 、70）")
    print()
    print("产物：")
    for label in ("A", "B"):
        if label in results:
            print("  " + results[label]["mp3"])
    print()
    print("听完告诉我哪条更自然。基线是 A，要改默认才动 seam_policy。")
    shutil.rmtree(work, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
