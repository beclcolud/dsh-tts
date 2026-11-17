"""splice 端点的回归测试：自己拉起服务，不需要 GPU、不需要模型。

用合成音频（三段不同频率的正弦波 + 静音）模拟"整段音频 + 句子边界"，
验证按采样点替换某一句之后：音频长度、内容、字幕、边界、以及各种拒绝路径。

用法：python scripts/test_splice.py
（用装有 numpy 的 python；服务端只用到 numpy 和标准库，不会加载任何模型。）
"""
import json
import math
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVER = HERE.parent / "server" / "tts_server.py"
SR = 24000
PORT = 17397
URL = "http://127.0.0.1:%d/" % PORT

fail = 0


def ok(cond, label, extra=""):
    global fail
    print(("  ok   " if cond else "  FAIL ") + label + ((" -> " + str(extra)) if not cond else ""))
    if not cond:
        fail += 1


def tone(freq, sec, amp=0.3):
    n = int(sec * SR)
    return [amp * math.sin(2 * math.pi * freq * i / SR) for i in range(n)]


def silence(sec):
    return [0.0] * int(sec * SR)


def write_wav(path, samples):
    with wave_open(path) as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, s)) * 32767)) for s in samples))


def wave_open(path):
    import wave
    return wave.open(str(path), "wb")


def read_wav(path):
    import wave
    with wave.open(str(path), "rb") as w:
        raw = w.readframes(w.getnframes())
    return [struct.unpack("<h", raw[i:i + 2])[0] for i in range(0, len(raw), 2)]


def call(req, **body):
    data = json.dumps({"req": req, **body}).encode()
    r = urllib.request.Request(URL, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except Exception:
            return {"ok": False, "error": "HTTP %d" % e.code}


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


def main():
    work = make_workdir("dsh-tts-splice-")
    cfg = work / "cfg.json"
    cfg.write_text(json.dumps({"work_dir": str(work), "models": {}, "port": PORT,
                               "idle_shutdown_ms": 600000}), encoding="utf-8")
    logfile = open(work / "server.log", "w", encoding="utf-8")
    proc = subprocess.Popen([sys.executable, str(SERVER), str(cfg)],
                            stdout=logfile, stderr=logfile)
    try:
        for _ in range(40):
            try:
                urllib.request.urlopen(URL + "health", timeout=2).read()
                break
            except Exception:
                time.sleep(0.5)
        else:
            print("服务没能起来，日志：")
            print((work / "server.log").read_text(encoding="utf-8", errors="replace")[-1200:])
            return 1
        run(work)
    finally:
        try:
            urllib.request.urlopen(urllib.request.Request(
                URL, data=json.dumps({"req": "shutdown"}).encode(),
                headers={"Content-Type": "application/json"}), timeout=5).read()
        except Exception:
            pass
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        shutil.rmtree(work, ignore_errors=True)
    print()
    print("全部通过" if fail == 0 else "%d 项失败" % fail)
    return 0 if fail == 0 else 1


def run(work: Path):
    full = tone(440, 0.6) + silence(0.12) + tone(880, 0.6) + silence(0.12) + tone(1320, 0.6)
    write_wav(work / "full.wav", full)
    n1, n2, total = int(0.72 * SR), int(1.44 * SR), len(full)
    bounds = {"sr": SR, "total": total, "sentences": [
        {"i": 1, "text": "第一句", "start": 0, "end": n1},
        {"i": 2, "text": "第二句", "start": n1, "end": n2},
        {"i": 3, "text": "第三句", "start": n2, "end": total},
    ]}
    (work / "full.bounds.json").write_text(json.dumps(bounds, ensure_ascii=False, indent=2), encoding="utf-8")
    write_wav(work / "take2.wav", tone(660, 0.35))

    print("[1] 替换第 2 句")
    res = call("splice", wav=str(work / "full.wav"), take=str(work / "take2.wav"),
               index=2, out_dir=str(work), stem="patched")
    ok(res.get("ok") is not False, "接口返回正常", res)
    out = read_wav(work / "patched.wav")
    ok(len(out) < total, "总长变短", (len(out) - total) / SR)
    ok(abs(res["delta"] - (len(out) - total) / SR) < 1e-3, "delta 与实际一致", res["delta"])

    def zcr(x):
        if len(x) < 2:
            return 0.0
        return sum(1 for i in range(1, len(x)) if (x[i - 1] < 0) != (x[i] < 0)) / (len(x) - 1)

    # 探测窗要放在替换区**中间**：贴着接缝测会把前一句的 440Hz 混进来，
    # 得到的是加权平均而不是新素材本身的频率。
    probe_a, probe_b = n1 + int(0.10 * SR), n1 + int(0.30 * SR)
    f_new = zcr(out[probe_a:probe_b]) * SR / 2
    ok(abs(f_new - 660) < 40, "替换区中间是新录的 660Hz", round(f_new))
    seam_left = zcr(out[n1 - int(0.06 * SR): n1 - int(0.01 * SR)]) * SR / 2
    ok(abs(seam_left - 440) < 60, "接缝之前仍是原来的 440Hz", round(seam_left))
    f_tail = zcr(out[-int(0.4 * SR):]) * SR / 2
    ok(abs(f_tail - 1320) < 80, "第三句还在原位", round(f_tail))

    print("[2] 字幕与边界同步")
    ok((work / "patched.srt").read_text(encoding="utf-8").count("-->") == 3, "字幕仍是 3 条")
    nb = json.loads((work / "patched.bounds.json").read_text(encoding="utf-8"))
    ok(len(nb["sentences"]) == 3, "新边界仍是 3 句")
    shift = (nb["sentences"][2]["start"] - bounds["sentences"][2]["start"]) / SR
    ok(abs(shift - res["delta"]) < 1e-3, "第三句按 delta 平移", shift)

    print("[3] 老音频（无边界文件）应明确拒绝")
    res2 = call("splice", wav=str(work / "take2.wav"), take=str(work / "take2.wav"), index=1, out_dir=str(work))
    ok(res2.get("ok") is False, "返回 ok:false")
    ok("边界文件" in str(res2.get("error", "")), "错误信息说明了原因", res2.get("error"))

    print("[4] 句子序号越界应明确拒绝")
    res3 = call("splice", wav=str(work / "full.wav"), take=str(work / "take2.wav"), index=9, out_dir=str(work))
    ok(res3.get("ok") is False, "返回 ok:false")
    ok("第 9 句" in str(res3.get("error", "")), "错误信息点出了序号", res3.get("error"))


if __name__ == "__main__":
    sys.exit(main())
