#!/usr/bin/env python3
"""强制对齐的端到端验证：真模型、真音频。

流程：起服务 → TTS 合成一句话 → 调 align 拿字级时间 → 检查
  1) 对齐结果覆盖了原文全部字符
  2) 时间单调、落在音频时长内
  3) 用 groupAlignedCues 同样的规则能拆出多条字幕

不需要 ComfyUI；需要 models/ 下同时有 TTS 和 ForcedAligner。
用法：python scripts/test_align_model.py
"""
import json
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PORT = 17392
URL = "http://127.0.0.1:%d/" % PORT
TEXT = "清早的菜市场是最热闹的地方。摊主一边摆菜，一边跟熟客打招呼。"

fail = 0


def ok(cond, label, extra=""):
    global fail
    print(("  ok   " if cond else "  FAIL ") + label + ((" -> " + str(extra)) if not cond else ""))
    if not cond:
        fail += 1


def make_workdir(prefix):
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
        with urllib.request.urlopen(r, timeout=600) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        raise SystemExit("服务返回 %d：%s" % (exc.code, exc.read().decode("utf-8", "replace")[:400]))


def main() -> int:
    models = ROOT.parent / "models"
    aligner = models / "Qwen3-ForcedAligner-0.6B"
    if not (aligner / "model.safetensors").exists():
        print("对齐模型还没下载完：%s" % aligner)
        return 2

    work = make_workdir("dsh-tts-align-")
    cfg = {
        "libs": str(ROOT.parent / "_tts_probe" / "pylibs"),
        "work_dir": str(work),
        "models": {
            "custom": str(models / "Qwen3-TTS-0.6B-CustomVoice"),
            "base": str(models / "Qwen3-TTS-0.6B-Base"),
            "asr": str(models / "Qwen3-ASR-0.6B"),
            "aligner": str(aligner),
        },
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
            print("服务没起来：")
            print((work / "server.log").read_text(encoding="utf-8", errors="replace")[-900:])
            return 1

        print("[1] TTS 合成一句（%d 字）" % len(TEXT))
        t0 = time.time()
        say = call("say", text=TEXT, kind="custom", voice={"speaker": "Serena"}, stem="a1",
                   out_dir=str(work), seam="target")
        print("      合成 %.2fs 音频，耗时 %.1fs" % (say["dur"], time.time() - t0))

        print("[2] 强制对齐")
        t0 = time.time()
        al = call("align", audio=say["wav"], text=TEXT)
        print("      对齐 %d 项，耗时 %.1fs" % (al["count"], time.time() - t0))
        items = al["items"]
        ok(al["count"] > 0, "返回了字级时间")
        ok(abs(len(items) - len(TEXT)) <= 4, "条目数接近字数", {"items": len(items), "chars": len(TEXT)})
        joined = "".join(i["text"] for i in items)
        ok(joined.replace(" ", "") == TEXT.replace(" ", ""), "拼回等于原文", joined)

        print("[3] 时间合理性")
        ok(all(i["end"] >= i["start"] for i in items), "每项 end >= start")
        ok(all(items[k]["start"] >= items[k - 1]["start"] for k in range(1, len(items))), "起始时间单调")
        last_end = max(i["end"] for i in items) / 1000.0
        ok(last_end <= say["dur"] + 0.2, "结束时间在音频时长内", {"last_end": round(last_end, 2), "dur": say["dur"]})
        span = (max(i["end"] for i in items) - min(i["start"] for i in items)) / 1000.0
        ok(span > say["dur"] * 0.7, "对齐覆盖了大部分时长", {"span": round(span, 2), "dur": say["dur"]})

        print("[4] 能拆出多条字幕")
        max_chars = 14
        cues, cur, cur_end = [], "", None
        for it in items:
            t = it["text"]
            start_s, end_s = it["start"] / 1000.0, it["end"] / 1000.0
            if cur == "":
                cur, cur_start, cur_end = t, start_s, end_s
                continue
            gap = (start_s - cur_end) * 1000
            if len(cur + t) > max_chars or gap > 350 or cur[-1] in "。！？；，、：":
                cues.append(cur.strip())
                cur, cur_start, cur_end = t, start_s, end_s
            else:
                cur += t
                cur_end = max(cur_end, end_s)
        if cur:
            cues.append(cur.strip())
        print("      拆出 %d 条：%s" % (len(cues), cues))
        ok(len(cues) >= 3, "长句被拆成多条", len(cues))
        ok(all(len(c) <= max_chars + 1 for c in cues), "每条不超过上限", [len(c) for c in cues])
    finally:
        try:
            call("shutdown")
        except Exception:
            pass
        try:
            proc.wait(timeout=15)
        except Exception:
            proc.kill()
        log.close()

    print()
    print("全部通过" if fail == 0 else "%d 项失败" % fail)
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
