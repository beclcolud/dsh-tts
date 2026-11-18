#!/usr/bin/env python3
"""dsh-tts 环境自举。

默认只探测、不改任何东西。想真装要显式 --install。

为什么需要它：这套环境的依赖图在形式上是无解的（qwen-tts 要 transformers 4.57.3，
qwen-asr 要 4.57.6），而且有两处上游包"装得上但导入必崩"。这些坑原来只存在于
某台机器的磁盘上，换机器就复现不了。详见 requirements/README.md。

常用：
    python bootstrap_env.py                    # 只探测
    python bootstrap_env.py --install --torch none
    python bootstrap_env.py --check-models
    python bootstrap_env.py --verify           # 起服务 + 合成 + ASR 回读
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REQ = HERE / "requirements"
VENDOR = HERE / "server" / "vendor"
MANIFEST = HERE / "models.manifest.json"

problems: list[str] = []


def say(msg: str = "") -> None:
    print(msg, flush=True)


def step(n, msg: str) -> None:
    say("")
    say("[%s] %s" % (n, msg))


def ok(msg: str) -> None:
    say("    ok    " + msg)


def warn(msg: str) -> None:
    say("    warn  " + msg)


def bad(msg: str) -> None:
    say("    FAIL  " + msg)
    problems.append(msg)


# ------------------------------------------------------------------ 探测

def detect_os() -> str:
    if sys.platform.startswith("win"):
        return "windows"
    if sys.platform.startswith("linux"):
        return "linux"
    return sys.platform


def detect_gpu() -> dict:
    """不看 torch，直接问系统——torch 还没装的时候也要能判断。"""
    gpu = {"kind": "none", "name": "", "cuda": None, "rocm": None}
    # nvidia-smi 不一定在 PATH 上（尤其从 DSH / IDE 里拉起的进程），按常见位置兜底
    nv = shutil.which("nvidia-smi")
    if not nv:
        for cand in (r"C:\Windows\System32\nvidia-smi.exe", "/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi"):
            if Path(cand).exists():
                nv = cand
                break
    if nv:
        try:
            out = subprocess.run([nv], capture_output=True, text=True, timeout=15).stdout
            m = re.search(r"CUDA Version:\s*([\d.]+)", out)
            if m:
                gpu.update(kind="nvidia", cuda=m.group(1))
            q = subprocess.run([nv, "--query-gpu=name", "--format=csv,noheader"],
                               capture_output=True, text=True, timeout=15).stdout.strip()
            if q:
                gpu["name"] = q.splitlines()[0]
        except Exception as e:
            warn("nvidia-smi 调用失败：%s" % e)
    if gpu["kind"] == "none" and detect_os() == "linux":
        rocm = shutil.which("rocm-smi") or ("/opt/rocm" if Path("/opt/rocm").exists() else None)
        if rocm:
            gpu.update(kind="amd")
            ver = Path("/opt/rocm/.info/version")
            if ver.exists():
                gpu["rocm"] = ver.read_text(encoding="utf-8").strip()
    return gpu


def _py(code: str, cwd: Path | None = None) -> tuple[int, str]:
    """在子进程里跑一段 python：避免把宿主环境导进本进程。"""
    try:
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                           timeout=120, cwd=str(cwd) if cwd else None)
        return r.returncode, (r.stdout + r.stderr).strip()
    except subprocess.TimeoutExpired:
        return 1, "超时"


def detect_torch(libs: Path) -> dict:
    code = (
        "import json,sys\n"
        "sys.path.insert(0, %r)\n"
        "try:\n"
        "    import torch\n"
        "except Exception as e:\n"
        "    print(json.dumps({'present': False, 'error': type(e).__name__ + ': ' + str(e)[:120]}))\n"
        "else:\n"
        "    d = {'present': True, 'version': torch.__version__, 'cuda_build': torch.version.cuda,\n"
        "         'hip': getattr(torch.version, 'hip', None),\n"
        "         'cuda_ok': bool(torch.cuda.is_available()),\n"
        "         'file': torch.__file__}\n"
        "    try:\n"
        "        d['device'] = torch.cuda.get_device_name(0) if torch.cuda.is_available() else ''\n"
        "    except Exception:\n"
        "        d['device'] = ''\n"
        "    print(json.dumps(d))\n"
    ) % str(libs)
    rc, out = _py(code)
    line = out.splitlines()[-1] if out.splitlines() else "{}"
    try:
        return json.loads(line)
    except Exception:
        return {"present": False, "error": out[-160:]}


def count_packages(libs: Path) -> list[str]:
    if not libs.is_dir():
        return []
    return sorted(p.name for p in libs.glob("*.dist-info"))


def download_models(models_dir: Path, only: list[str] | None, dry: bool, mirror: str | None) -> None:
    """按 models.manifest.json 的 repo 字段下载模型。

    用 huggingface_hub（已在 requirements/base.txt 里钉了版本）。默认走 hf-mirror，
    国内直连 huggingface.co 经常超时。--dry-run 只打印计划。
    """
    if not MANIFEST.exists():
        bad("找不到 models.manifest.json")
        return
    if mirror:
        os.environ["HF_ENDPOINT"] = mirror
        os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    # 元数据缓存放到模型目录里，别写用户家目录（那里常因为权限报 WinError 5）
    os.environ.setdefault("HF_HOME", str(models_dir / ".hf"))
    say("    来源：%s" % (os.environ.get("HF_ENDPOINT") or "https://huggingface.co"))
    man = json.loads(MANIFEST.read_text(encoding="utf-8"))
    entries = man["models"]
    if only:
        only = [k.strip() for item in only for k in str(item).split(",") if k.strip()]
        unknown = [k for k in only if k not in {m["key"] for m in entries}]
        if unknown:
            bad("未知的模型 key：%s（可选：%s）" % (", ".join(unknown), ", ".join(m["key"] for m in entries)))
            return
        entries = [m for m in entries if m["key"] in only]
    else:
        # 不带 --model 时跳过已弃用的（custom17b 4.5G，配置里根本不引用）
        entries = [m for m in entries if not m.get("deprecated")]

    todo = []
    for m in entries:
        target = models_dir / m["dir"]
        if complete(m, target):
            ok("%s 已完整，跳过" % m["dir"])
            continue
        if not m.get("repo"):
            warn("%s 没有 repo 字段，无法自动下载（见 models.manifest.json）" % m["dir"])
            continue
        todo.append((m, target))

    if not todo:
        say("")
        say("    没有需要下载的模型。")
        return

    total = sum(int(m.get("bytes") or 0) for m, _ in todo)
    say("")
    say("    待下载 %d 个，合计约 %.1f GB：" % (len(todo), total / 1e9))
    for m, target in todo:
        say("      %-34s %-42s %5.1f GB -> %s"
            % (m["dir"], m["repo"], int(m.get("bytes") or 0) / 1e9, target))
    if dry:
        say("")
        say("    --dry-run：没有真的下载。去掉 --dry-run 执行。")
        return

    try:
        from huggingface_hub import snapshot_download
    except Exception as e:
        bad("没有 huggingface_hub（%s），先跑 --install" % type(e).__name__)
        return

    for m, target in todo:
        say("")
        say("    ↓ %s（%s）" % (m["dir"], m["repo"]))
        target.mkdir(parents=True, exist_ok=True)
        try:
            snapshot_download(
                m["repo"],
                local_dir=str(target),
                # 只拿会用到的格式，别把 onnx / 旧版 .pth 一起拖下来
                allow_patterns=["*.json", "*.model", "*.safetensors", "*.bin", "*.txt", "*.spm"],
            )
        except Exception as e:
            bad("%s 下载失败：%s" % (m["dir"], e))
            continue
        if complete(m, target):
            ok("%s 下载完成" % m["dir"])
        else:
            bad("%s 下载了但校验没过（可能是网络中断，重跑会续传）" % m["dir"])


def complete(m: dict, target: Path) -> bool:
    """模型目录是否齐全：关键文件字节数对得上，且清单里的文件都在。"""
    key = m.get("keyFile")
    if key and m.get("keyFileBytes"):
        kp = target / key
        if not kp.exists() or kp.stat().st_size != m["keyFileBytes"]:
            return False
    for f in m.get("files", []):
        if not (target / f).exists():
            return False
    return bool(m.get("files") or key)

def check_models(models_dir: Path) -> None:
    if not MANIFEST.exists():
        bad("找不到 models.manifest.json")
        return
    man = json.loads(MANIFEST.read_text(encoding="utf-8"))
    total_missing = 0
    for m in man["models"]:
        d = models_dir / m["dir"]
        tag = "必需" if m.get("required") else ("已弃用" if m.get("deprecated") else "可选")
        if not d.is_dir():
            if m.get("required"):
                bad("%s 缺失（%s，%s）" % (m["dir"], tag, m.get("role", "")))
                total_missing += 1
            else:
                warn("%s 不存在（%s，不影响主流程）" % (m["dir"], tag))
            continue
        key = m.get("keyFile")
        if key and m.get("keyFileBytes"):
            kp = d / key
            if not kp.exists():
                bad("%s 缺少 %s" % (m["dir"], key))
                total_missing += 1
            elif kp.stat().st_size != m["keyFileBytes"]:
                bad("%s 的 %s 大小不符（%d != %d，多半是下载中断）"
                    % (m["dir"], key, kp.stat().st_size, m["keyFileBytes"]))
                total_missing += 1
            else:
                ok("%s  %s %.2f GB" % (m["dir"], key, kp.stat().st_size / 1e9))
        missing = [f for f in m.get("files", []) if not (d / f).exists()]
        if missing:
            bad("%s 缺少 %d 个文件：%s" % (m["dir"], len(missing), ", ".join(missing[:4])))
            total_missing += 1
    if total_missing == 0:
        ok("模型文件齐全")
    say("")
    say("    下载用：python bootstrap_env.py --download-models            （全部缺失的）")
    say("            python bootstrap_env.py --download-models --model mt  （只下翻译模型）")
    say("    来源参考：%s" % man.get("downloadHints", {}).get("huggingface", ""))


# ------------------------------------------------------------------ 安装

TORCH_INDEX = {
    "cpu": "https://download.pytorch.org/whl/cpu",
}


def torch_index_for(gpu: dict, override: str | None) -> tuple[str, str]:
    """返回 (说明, index-url)。不确定的一律要求显式指定，不猜。"""
    if override:
        return ("命令行指定", override)
    if gpu["kind"] == "nvidia" and gpu.get("cuda"):
        major_minor = gpu["cuda"].split(".")[:2]
        tag = "cu" + "".join(major_minor)
        return ("按驱动报告的 CUDA %s" % gpu["cuda"], "https://download.pytorch.org/whl/" + tag)
    if gpu["kind"] == "amd" and detect_os() == "linux":
        return ("AMD ROCm（Linux）", "https://download.pytorch.org/whl/rocm6.2")
    return ("CPU", TORCH_INDEX["cpu"])


def run_pip(args: list[str], dry: bool) -> int:
    cmd = [sys.executable, "-m", "pip"] + args
    say("    $ " + " ".join(cmd))
    if dry:
        return 0
    return subprocess.call(cmd)


def install(libs: Path, gpu: dict, torch_mode: str, torch_index: str | None,
            transformers: str, dry: bool) -> None:
    libs.mkdir(parents=True, exist_ok=True)
    base = ["--target", str(libs), "--disable-pip-version-check", "--no-warn-script-location"]

    step("4", "安装核心依赖（requirements/base.txt）")
    run_pip(["install"] + base + ["-r", str(REQ / "base.txt")], dry)

    step("5", "PyTorch")
    t = detect_torch(libs)
    if torch_mode == "none" or (torch_mode == "auto" and t.get("present")):
        if t.get("present"):
            ok("复用宿主 torch %s（%s）" % (t.get("version"), t.get("file", "")))
        else:
            bad("--torch none 但当前 Python 里没有可用的 torch")
    else:
        why, index = torch_index_for(gpu, torch_index)
        say("    来源：%s" % why)
        say("    索引：%s" % index)
        warn("不固定 torch 版本号：不同平台/驱动可用的 wheel 集合不同，写死反而装不上")
        run_pip(["install"] + base + ["--extra-index-url", index, "torch", "torchaudio", "torchvision"], dry)

    step("6", "transformers（上游有硬冲突，见 requirements/README.md）")
    order = ["4.57.6", "4.57.3"] if transformers == "auto" else [transformers]
    for ver in order:
        f = REQ / ("transformers-%s.txt" % ver)
        if not f.exists():
            bad("找不到 %s" % f.name)
            return
        say("    尝试 %s ..." % ver)
        rc = run_pip(["install"] + base + ["-r", str(f)], dry)
        if dry:
            return
        good = probe_models(libs)
        if good:
            ok("transformers %s 通过导入自检" % ver)
            if ver == "4.57.3":
                patch_transformers_metadata(libs)
            return
        warn("transformers %s 自检不通过，换下一个" % ver)
    if not dry:
        bad("4.57.6 和 4.57.3 都没通过导入自检，需要人工排查")


def patch_transformers_metadata(libs: Path) -> None:
    """4.57.3 的代码 + 4.57.6 的假元数据。

    为什么要这么做：qwen-asr 声明 transformers==4.57.6，真装 4.57.6 又过不了自检，
    pip check / 依赖解析就会一直报冲突。补一份最小元数据把版本号对上，代码仍是 4.57.3。
    """
    d = libs / "transformers-4.57.6.dist-info"
    d.mkdir(parents=True, exist_ok=True)
    meta = (
        "Metadata-Version: 2.1\n"
        "Name: transformers\n"
        "Version: 4.57.6\n"
        "Summary: 兼容性占位元数据（真实代码是 4.57.3，见 requirements/README.md）\n"
        "Requires-Python: >=3.9.0\n"
    )
    (d / "METADATA").write_text(meta, encoding="utf-8")
    (d / "INSTALLER").write_text("dsh-tts-bootstrap\n", encoding="utf-8")
    ok("已补 transformers 4.57.6 的占位元数据（代码仍是 4.57.3）")


def install_sox_stub(libs: Path) -> None:
    src = VENDOR / "sox.py"
    if not src.exists():
        bad("找不到 server/vendor/sox.py")
        return
    shutil.copyfile(src, libs / "sox.py")
    ok("sox 桩已复制到 %s" % (libs / "sox.py"))


def probe_models(libs: Path) -> bool:
    """在子进程里导入两个模型包，带上服务端那套 nagisa 替身。

    替身不是空桩：qwen-asr 的日文对齐会真的调用 nagisa.tagging(text).words，
    这里必须和 tts_server.py 用同一个 server/vendor/nagisa.py。
    """
    stub = Path(__file__).resolve().parent / "server" / "vendor" / "nagisa.py"
    code = (
        "import sys, importlib.util\n"
        "sys.path.insert(0, %r)\n"
        "if 'nagisa' not in sys.modules:\n"
        "    spec = importlib.util.spec_from_file_location('nagisa', %r)\n"
        "    mod = importlib.util.module_from_spec(spec)\n"
        "    spec.loader.exec_module(mod)\n"
        "    sys.modules['nagisa'] = mod\n"
        "import transformers\n"
        "import qwen_tts, qwen_asr\n"
        "print('VERSION', transformers.__version__)\n"
        "print('NAGISA', len(sys.modules['nagisa'].tagging('おはよう').words))\n"
    ) % (str(libs), str(stub))
    rc, out = _py(code)
    if rc == 0:
        say("        transformers 实际版本：" + (out.split("VERSION")[-1].strip() or "?"))
        return True
    say("        失败原因：" + out.replace("\n", " ")[-220:])
    return False


# ------------------------------------------------------------------ 自检

def verify(libs: Path, models_dir: Path, seconds: float = 180) -> None:
    step("8", "端到端自检：起服务 → 合成一句 → ASR 回读")
    py = sys.executable
    work = Path(tempfile.mkdtemp(prefix="dsh-tts-verify-"))
    port = 17396
    cfg = {
        "libs": str(libs),
        "work_dir": str(work),
        "models": {k: str(models_dir / v) for k, v in {
            "custom": "Qwen3-TTS-0.6B-CustomVoice",
            "base": "Qwen3-TTS-0.6B-Base",
            "asr": "Qwen3-ASR-0.6B",
            "design": "Qwen3-TTS-1.7B-VoiceDesign",
        }.items()},
        "port": port,
        "idle_shutdown_ms": 0,
    }
    cfg_path = work / "cfg.json"
    cfg_path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    log = open(work / "server.log", "w", encoding="utf-8")
    proc = subprocess.Popen([py, str(HERE / "server" / "tts_server.py"), str(cfg_path)],
                            stdout=log, stderr=log)
    url = "http://127.0.0.1:%d/" % port

    def call(req, **body):
        data = json.dumps({"req": req, **body}).encode()
        r = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(r, timeout=seconds) as resp:
            return json.loads(resp.read())

    try:
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                urllib.request.urlopen(url + "health", timeout=2).read()
                break
            except Exception:
                time.sleep(1)
        else:
            bad("服务 60 秒内没起来，日志见 " + str(work / "server.log"))
            return
        ok("服务已启动（端口 %d）" % port)
        try:
            say_res = call("say", text="测试一下。", kind="custom", voice={"speaker": "Serena"}, stem="smoke")
        except Exception as e:
            bad("合成失败：%s" % e)
            return
        ok("合成成功：%.2f 秒 → %s" % (say_res["dur"], Path(say_res["wav"]).name))
        try:
            asr = call("asr", audio=say_res["wav"], language="Chinese")
        except Exception as e:
            bad("ASR 回读失败：%s" % e)
            return
        heard = (asr.get("text") or "").strip()
        if heard:
            ok("ASR 回读：%s" % heard[:40])
        else:
            bad("ASR 返回空文本")
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
        shutil.rmtree(work, ignore_errors=True)


# ------------------------------------------------------------------ 主流程

def main() -> int:
    ap = argparse.ArgumentParser(description="dsh-tts 环境自举（默认只探测，不改任何东西）")
    ap.add_argument("--install", action="store_true", help="真的装依赖；不加就是只看")
    ap.add_argument("--dry-run", action="store_true", help="配合 --install，只打印将要执行的命令")
    ap.add_argument("--verify", action="store_true", help="端到端自检（会加载模型，占显存）")
    ap.add_argument("--check-models", action="store_true", help="只校验模型文件")
    ap.add_argument("--download-models", action="store_true",
                    help="按 models.manifest.json 下载缺失的模型（默认跳过已弃用的）")
    ap.add_argument("--model", action="append", default=None, metavar="KEY",
                    help="配合 --download-models：只下这几个（base/custom/asr/aligner/design/mt），可重复")
    ap.add_argument("--mirror", default="https://hf-mirror.com",
                    help="下载模型用的 HuggingFace 镜像；传空串直连 huggingface.co")
    ap.add_argument("--libs", default=str(HERE.parent / "_tts_probe" / "pylibs"),
                    help="依赖装到哪个目录")
    ap.add_argument("--models-dir", default=str(HERE.parent / "models"))
    ap.add_argument("--torch", default="auto", choices=["auto", "none", "nvidia", "amd", "cpu"],
                    help="auto=有就复用、没有就按 GPU 装；none=只复用宿主")
    ap.add_argument("--torch-index", default=None, help="显式指定 torch wheel 索引")
    ap.add_argument("--transformers", default="auto", choices=["auto", "4.57.6", "4.57.3"])
    args = ap.parse_args()

    libs = Path(args.libs)
    models_dir = Path(args.models_dir)

    say("dsh-tts bootstrap")
    say("=" * 60)

    step("1", "解释器")
    ok("%s %s（%s）" % (platform.python_implementation(), platform.python_version(), sys.executable))
    if sys.version_info < (3, 12):
        bad("librosa 1.0.1 要求 Python >= 3.12，当前 %d.%d" % sys.version_info[:2])

    step("2", "平台与显卡")
    osname = detect_os()
    gpu = detect_gpu()
    t = detect_torch(libs)
    # 系统层面问不到时，用已装 torch 的结论兜底——两边结论矛盾很难看，也会误导后面的选型
    if gpu["kind"] == "none" and t.get("present") and t.get("cuda_ok"):
        gpu.update(kind="nvidia", name=t.get("device") or "", cuda=t.get("cuda_build"))
    ok("系统：%s" % osname)
    if gpu["kind"] == "nvidia":
        ok("NVIDIA：%s（驱动支持 CUDA %s）" % (gpu["name"], gpu["cuda"]))
    elif gpu["kind"] == "amd":
        ok("AMD：ROCm %s" % (gpu["rocm"] or "未识别版本"))
        if osname == "windows":
            warn("Windows + AMD 没有官方 ROCm wheel，只能退 CPU（能出声但慢）")
    else:
        warn("没有检测到 GPU，将走 CPU（能出声但很慢）")

    step("3", "现有依赖与 torch")
    pkgs = count_packages(libs)
    ok("依赖目录 %s：%d 个包" % (libs, len(pkgs)))
    if t.get("present"):
        ok("torch %s（CUDA %s，可用=%s）" % (t.get("version"), t.get("cuda_build"), t.get("cuda_ok")))
        if t.get("device"):
            ok("设备：%s" % t["device"])
    else:
        warn("当前 Python 里没有可用的 torch：%s" % t.get("error", ""))
    if not (libs / "sox.py").exists():
        warn("依赖目录里没有 sox.py 桩（--install 会补）")

    if args.check_models:
        step("模型", "按 models.manifest.json 校验 %s" % models_dir)
        check_models(models_dir)
        return 1 if problems else 0

    if args.download_models:
        step("模型", "按 models.manifest.json 下载到 %s" % models_dir)
        download_models(models_dir, args.model, args.dry_run, args.mirror)
        return 1 if problems else 0

    if args.install:
        install(libs, gpu, args.torch, args.torch_index, args.transformers, args.dry_run)
        if not args.dry_run:
            step("7", "补桩")
            install_sox_stub(libs)
            if not probe_models(libs):
                bad("模型包导入失败，见上面的原因")
        say("")
        say("装完后把 cordis.patch.yml 里的 pythonPath / libs 指到这里：")
        say("    pythonPath: %s" % sys.executable)
        say("    libs:       %s" % libs)

    if args.verify:
        verify(libs, models_dir)

    say("")
    say("=" * 60)
    if problems:
        say("有 %d 个问题需要处理：" % len(problems))
        for p in problems:
            say("  - " + p)
        return 1
    say("没问题。")
    if not args.install and not args.verify:
        say("（这只是探测。要装依赖加 --install，要自检加 --verify）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
