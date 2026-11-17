"""dsh-tts resident service.

A single long-lived process that owns all GPU models (Qwen3-TTS CustomVoice /
VoiceDesign / Base, Qwen3-ASR) and the UVR vocal separator. The DSH plugin
talks to it over localhost HTTP, keeping model loads out of the request path.

Design notes:
* One global lock - CUDA models are not safe to run concurrently on 8 GB.
* Residency: CustomVoice stays loaded; switching to VoiceDesign / Base / ASR
  frees the previous model first, and an idle watchdog frees everything.
* Stdlib http.server only, so it runs on whatever Python the user has.
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

def _bootstrap_tmp():
    """Point TEMP/TMP at the work dir before any heavy import.

    The host process may inherit a TEMP pointing at a directory the child cannot
    create files in; Python then dies with "No usable temporary directory" while
    importing torch. Fixing it here keeps the fix independent of the host env.
    """
    try:
        cfg = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        base = Path(cfg.get("work_dir") or ".")
        tmp = base / ".tmp"
        tmp.mkdir(parents=True, exist_ok=True)
        for key in ("TEMP", "TMP", "TMPDIR"):
            os.environ[key] = str(tmp)
        import tempfile
        tempfile.tempdir = str(tmp)
    except Exception:
        pass


_bootstrap_tmp()

CONFIG: dict = {}
LOCK = threading.Lock()
STATE: dict = {"last_activity": time.time(), "loaded": None, "started": time.time()}


def log(*parts):
    print(time.strftime("[%H:%M:%S] ") + " ".join(str(p) for p in parts), flush=True)


def out_dir() -> Path:
    p = Path(CONFIG["work_dir"]).expanduser()
    p.mkdir(parents=True, exist_ok=True)
    return p


def save_wav(path: Path, arr, sr: int) -> None:
    import numpy as np
    a = np.asarray(arr, dtype=np.float32)
    if a.ndim > 1:
        a = a.squeeze()
    pcm = (np.clip(a, -1.0, 1.0) * 32767.0).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm.tobytes())


def load_wav(path: Path):
    import numpy as np
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        raw = w.readframes(w.getnframes())
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32767.0
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    return a, sr


def fmt_ts(sec: float) -> str:
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return "%02d:%02d:%02d,%03d" % (h, m, s, ms)


def split_sentences(text: str) -> list:
    parts = re.split(r"(?<=[。！？!?；;\n])", text)
    out = [p.strip() for p in parts if p.strip()]
    return out or [text.strip()]


class Models:
    """Lazily loads one TTS/ASR model at a time and frees the previous one."""

    def __init__(self):
        self.kind = None
        self.obj = None

    def _free(self):
        import torch
        self.obj = None
        self.kind = None
        torch.cuda.empty_cache()

    def get(self, kind: str):
        if self.kind == kind:
            return self.obj
        import torch
        from qwen_tts import Qwen3TTSModel
        self._free()
        t0 = time.time()
        if kind in ("custom", "design", "base"):
            path = CONFIG["models"][kind]
            self.obj = Qwen3TTSModel.from_pretrained(
                path, device_map="cuda:0", dtype=torch.bfloat16, attn_implementation="sdpa")
        elif kind == "asr":
            import types
            fake = types.ModuleType("nagisa")
            fake.tagging = lambda *a, **k: []
            sys.modules.setdefault("nagisa", fake)
            from qwen_asr import Qwen3ASRModel
            self.obj = Qwen3ASRModel.from_pretrained(
                CONFIG["models"]["asr"], dtype=torch.bfloat16, device_map="cuda:0",
                max_inference_batch_size=1, max_new_tokens=512)
        else:
            raise ValueError("unknown model kind: " + kind)
        self.kind = kind
        STATE["loaded"] = kind
        log("loaded", kind, "in %.1fs, vram %.2fGB" % (
            time.time() - t0, torch.cuda.memory_allocated() / 1e9))
        return self.obj

    def free_all(self):
        if self.kind is not None:
            self._free()
            STATE["loaded"] = None
            log("freed all models")


MODELS = Models()


DICTION_INSTRUCT = "咬字清晰，字与字之间要分明，不要连读"
DEFAULT_BLUR_WORDS = ["答案", "牛奶"]
# A comma makes the model punch the second syllable (Dylan sounded excited).
# The 顿号 reads as a short breath: enough to stop the slur, not enough to shout.
BLUR_SEP = "、"


def apply_blur_fix(text: str):
    """Break up words whose syllables merge into one.

    "答案" comes out as a single slurred "dan": the first syllable's tail has not
    ended when the next onset starts. Inserting a light break between the
    characters forces the model to finish each one (verified by ear on Dylan).
    """
    words = CONFIG.get("blur_words") or DEFAULT_BLUR_WORDS
    out = text
    for w in words:
        if w in out:
            out = out.replace(w, BLUR_SEP.join(list(w)))
    return out


def split_for_blur(sentence: str):
    """Cut a sentence right after the first character of a blur-prone word.

    The model only breaks where punctuation tells it to, and that break length is
    its own (measured ~400 ms gap, which reads as a stumble or a shout). Splicing
    two renders lets us place an exact, short gap instead.
    """
    words = CONFIG.get("blur_words") or DEFAULT_BLUR_WORDS
    for w in words:
        idx = sentence.find(w)
        if idx >= 0:
            cut = idx + 1
            return [sentence[:cut], sentence[cut:]]
    return [sentence]


def _render_once(model, kind: str, text: str, voice: dict, do_trim: bool = True):
    import numpy as np
    import torch
    # Deterministic mode: greedy decoding + a fixed RNG seed before every call.
    # The 1.7B checkpoint samples by default, which made the same speaker drift in
    # pitch between sentences; pinning both removes that freedom.
    deterministic = CONFIG.get("sample", True) is False
    if deterministic:
        torch.manual_seed(int(CONFIG.get("seed", 20261116)))
    if kind == "custom":
        want_blur = voice.get("blur", True)
        speech_text = apply_blur_fix(text) if (want_blur and CONFIG.get("blur_mode", "punct") == "punct") else text
        instruct = voice.get("instruct") or ""
        if CONFIG.get("diction", True):
            instruct = (instruct + "，" + DICTION_INSTRUCT) if instruct else DICTION_INSTRUCT
        kw = {"text": speech_text, "language": voice.get("language", "Chinese"), "speaker": voice["speaker"]}
        if instruct:
            kw["instruct"] = instruct
        if deterministic:
            kw["do_sample"] = False
        wavs, sr = model.generate_custom_voice(**kw)
    elif kind == "design":
        wavs, sr = model.generate_voice_design(
            text=text, instruct=voice["instruct"], language=voice.get("language", "Chinese"))
    elif kind == "base":
        wavs, sr = model.generate_voice_clone(
            text=text, language=voice.get("language", "Chinese"),
            ref_audio=voice["ref_audio"], ref_text=voice.get("ref_text"))
    else:
        raise ValueError("not a tts model: " + kind)
    audio = np.asarray(wavs[0], dtype=np.float32).squeeze()
    return (trim_silence(audio, sr) if do_trim else audio), int(sr)


def trim_silence(a, sr, keep_head: float = 0.025, keep_tail: float = 0.025, head_ratio: float = 0.005):
    """Cut near-silence at both ends.

    Each per-sentence render comes with its own leading/trailing silence; keeping
    it while concatenating makes sentence boundaries sound like long, odd pauses.
    """
    import numpy as np
    # A softer threshold on the way in: an attack that ramps up over 30-40 ms gets
    # clipped by a 2% gate, and the first syllable then sounds cut in half.
    thr = max(1e-4, float(np.max(np.abs(a))) * head_ratio)
    idx = np.where(np.abs(a) > thr)[0]
    if len(idx) == 0:
        return a
    start = max(0, idx[0] - int(keep_head * sr))
    end = min(len(a), idx[-1] + int(keep_tail * sr))
    return a[start:end]


def energy_dips(a, sr, win_s: float = 0.02, hop_s: float = 0.01):
    """Return candidate boundary times (seconds) at local energy minima."""
    import numpy as np
    win = max(2, int(win_s * sr)); hop = max(1, int(hop_s * sr))
    rms = np.array([float(np.sqrt(np.mean(a[i:i + win] ** 2)) + 1e-12)
                    for i in range(0, max(1, len(a) - win), hop)])
    if len(rms) < 3:
        return []
    thr = rms.max() * 0.08
    idx = np.where(rms < thr)[0]
    # collapse consecutive quiet frames into their centre
    runs, cur = [], []
    for i in idx:
        if cur and i - cur[-1] <= 2:
            cur.append(i)
        else:
            if cur:
                runs.append(int(np.mean(cur)))
            cur = [i]
    if cur:
        runs.append(int(np.mean(cur)))
    return [r * hop / sr for r in runs]


def allocate_bounds(text: str, a, sr: int):
    """Lay sentence subtitles over one continuous take.

    Synthesising the whole passage in a single call keeps pitch and tone stable;
    timings are then allocated by character share and snapped to nearby energy
    dips, which lands on the real pauses far more often than a fixed split.
    """
    sentences = split_sentences(text)
    total = len(a) / sr
    if len(sentences) <= 1:
        return [(0.0, total, text.strip())]
    weights = [max(1, len(s)) for s in sentences]
    acc, bounds, cursor = sum(weights), [], 0.0
    dips = energy_dips(a, sr)
    for i, s in enumerate(sentences):
        cursor += total * weights[i] / acc
        if i < len(sentences) - 1:
            near = [d for d in dips if abs(d - cursor) <= 0.6]
            boundary = min(near, key=lambda d: abs(d - cursor)) if near else cursor
            if i == 0:
                bounds.append((0.0, boundary, s))
            else:
                bounds.append((bounds[-1][1], boundary, s))
            cursor = boundary
        else:
            bounds.append((bounds[-1][1] if bounds else 0.0, total, s))
    return bounds


def synth_passage(kind: str, text: str, voice: dict):
    """One generation per passage (not per sentence) to keep prosody stable.

    Long scripts are cut at sentence boundaries into ~90-character passages: far
    fewer seams than per-sentence synthesis, and each seam falls on a full stop.
    """
    import numpy as np
    model = MODELS.get(kind)
    passages, cur = [], ""
    for s in split_sentences(text):
        if cur and len(cur) + len(s) > 90:
            passages.append(cur)
            cur = s
        else:
            cur += s
    if cur:
        passages.append(cur)

    chunks, bounds, cursor, sr = [], [], 0.0, 24000
    for p in passages:
        if kind == "custom":
            kw = {"text": p, "language": voice.get("language", "Chinese"), "speaker": voice["speaker"]}
            if voice.get("instruct"):
                kw["instruct"] = voice["instruct"]
            wavs, sr = model.generate_custom_voice(**kw)
        elif kind == "design":
            wavs, sr = model.generate_voice_design(
                text=p, instruct=voice["instruct"], language=voice.get("language", "Chinese"))
        elif kind == "base":
            wavs, sr = model.generate_voice_clone(
                text=p, language=voice.get("language", "Chinese"),
                ref_audio=voice["ref_audio"], ref_text=voice.get("ref_text"))
        else:
            raise ValueError("not a tts model: " + kind)
        a = trim_silence(np.asarray(wavs[0], dtype=np.float32).squeeze(), sr)
        for (st, en, txt) in allocate_bounds(p, a, sr):
            bounds.append((cursor + st, cursor + en, txt))
        chunks.append(a)
        chunks.append(np.zeros(int(0.10 * sr), dtype=np.float32))
        cursor += len(a) / sr + 0.10
    audio = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
    return audio, int(sr), bounds


def nasality(a, sr):
    """Lower is clearer. Ratio of low-mid (200-600 Hz) to presence (1.2-3.5 kHz)."""
    import numpy as np
    n = 4096; hop = 2048
    frames = [a[i:i + n] * np.hanning(n) for i in range(0, max(1, len(a) - n), hop)]
    if not frames:
        return 0.0
    mag = np.mean(np.abs(np.fft.rfft(frames, axis=1)), axis=0)
    f = np.fft.rfftfreq(n, 1 / sr)
    lo = float(np.mean(mag[(f >= 200) & (f < 600)]) + 1e-12)
    hi = float(np.mean(mag[(f >= 1200) & (f < 3500)]) + 1e-12)
    return float(20 * np.log10(lo / hi))



def apply_fade(a, sr, ms: float = 3.0):
    """Tiny fade at both edges: a cut landing on a non-zero sample ticks."""
    import numpy as np
    n = int(ms / 1000 * sr)
    if n <= 0 or n * 2 >= len(a):
        return a
    w = np.linspace(0.0, 1.0, n, dtype=np.float32)
    b = a.copy()
    b[:n] *= w
    b[-n:] *= w[::-1]
    return b


def _edge_silence(a, sr, level: float = 0.01):
    """(leading, trailing) silence in seconds at a fixed audibility level."""
    import numpy as np
    idx = np.where(np.abs(a) > level)[0]
    if len(idx) == 0:
        return 0.0, 0.0
    return idx[0] / sr, (len(a) - 1 - idx[-1]) / sr


def join_with_overlap(left, right, sr, overlap_ms: float, trigger_ms: float):
    """Butt-join, unless the seam holds a real gap - then crossfade briefly.

    A long gap at a sentence boundary reads as a hiccup while a short one is part
    of normal prosody, so only the former gets an overlap.
    """
    import numpy as np
    _, tail = _edge_silence(left, sr)
    head, _ = _edge_silence(right, sr)
    gap_ms = (tail + head) * 1000.0
    ov = int(round(overlap_ms / 1000.0 * sr)) if gap_ms > trigger_ms else 0
    if ov <= 0 or ov >= len(left) or ov >= len(right):
        return np.concatenate([left, right]), len(left) / sr, gap_ms, 0
    f = np.linspace(0.0, 1.0, ov, dtype=np.float32)
    mixed = left[-ov:] * (1.0 - f) + right[:ov] * f
    start = (len(left) - ov) / sr
    return np.concatenate([left[:-ov], mixed, right[ov:]]), start, gap_ms, ov



def normalize_output(a, sr, target_rms_db: float = -20.0, peak_ceiling: float = 0.95):
    """Bring every render to a comparable loudness.

    Raw model output varies by 15+ dB between takes, so one clip plays far quieter
    than the next; boosting a quiet clip in a player also exposes its own plosives,
    which is what 'clipping' actually sounded like. Gain by RMS, then back off if
    the result would clip.
    """
    import numpy as np
    if len(a) == 0:
        return a
    rms = float(np.sqrt(np.mean(a ** 2)))
    peak = float(np.max(np.abs(a)))
    if rms <= 1e-7 or peak <= 1e-7:
        return a
    target = 10 ** (target_rms_db / 20.0)
    gain = target / rms
    gain = min(gain, 10 ** (24 / 20.0))
    if peak * gain > peak_ceiling:
        gain = peak_ceiling / peak
    return a * gain


def match_loudness(chunks, max_gain_db: float = 6.0):
    """Even out per-sentence level without flattening the performance.

    Each sentence is its own render, so the model drifts in loudness (we measured
    one sentence 3 dB quieter than the others, which reads as a random dip). Only
    the gain is touched - pitch and timing stay exactly as generated.
    """
    import numpy as np
    rms = [float(np.sqrt(np.mean(c ** 2)) + 1e-9) for c in chunks]
    target = float(np.median(rms))
    out = []
    for c, r in zip(chunks, rms):
        if r <= 1e-7:
            out.append(c)
            continue
        gain = min(max(target / r, 10 ** (-max_gain_db / 20)), 10 ** (max_gain_db / 20))
        out.append(c * gain)
    peak = max(float(np.max(np.abs(c))) for c in out) if out else 0.0
    if peak > 0.98:
        k = 0.98 / peak
        out = [c * k for c in out]
    return out


def synth_sentences(kind: str, text: str, voice: dict, gap: float = 0.12, takes: int = 1, do_trim: bool = True):
    """Synthesize sentence by sentence so the subtitle timeline is exact."""
    import numpy as np
    model = MODELS.get(kind)
    pieces, bounds = [], []
    cursor = 0.0
    sr = 24000
    gap_ms = float(CONFIG.get("blur_gap_ms", 80))
    for sentence in split_sentences(text):
        parts = []
        pieces_of_sentence = split_for_blur(sentence) if CONFIG.get("blur_mode") == "split" else [sentence]
        for piece in pieces_of_sentence:
            best_a, best_score = None, 1e9
            for _take in range(1 if CONFIG.get('sample', True) is False else max(1, takes)):
                a_try, sr_try = _render_once(model, kind, piece, voice, do_trim)
                score = nasality(a_try, sr_try)
                if score < best_score:
                    best_a, best_score, sr = a_try, score, sr_try
            parts.append(best_a)
        if len(parts) > 1:
            pad = np.zeros(int(gap_ms / 1000 * sr), dtype=np.float32)
            joined = [parts[0]]
            for p2 in parts[1:]:
                joined.extend([pad, p2])
            a = np.concatenate(joined)
        else:
            a = parts[0]
        dur = len(a) / sr
        pieces.append(a)
        bounds.append((cursor, cursor + dur, sentence))
        cursor += dur + gap
    keep_ms = float(CONFIG.get("edge_keep_ms", 25))
    overlap_ms = float(CONFIG.get("overlap_ms", 10))
    trigger_ms = float(CONFIG.get("overlap_trigger_ms", 120))
    fade_ms = float(CONFIG.get("fade_ms", 3))
    pieces = [apply_fade(trim_silence(p, sr, keep_ms / 1000.0, keep_ms / 1000.0), sr, fade_ms) for p in pieces]
    pieces = match_loudness(pieces)
    if not pieces:
        return np.zeros(0, dtype=np.float32), int(sr), bounds
    audio = pieces[0]
    starts = [0.0]
    for nxt in pieces[1:]:
        audio, start, _gap, _ov = join_with_overlap(audio, nxt, sr, overlap_ms, trigger_ms)
        starts.append(start)
    audio = normalize_output(audio, sr)
    total = len(audio) / sr
    bounds = [(starts[i], starts[i + 1] if i + 1 < len(starts) else total, t) for i, (_a, _b, t) in enumerate(bounds)]
    return audio, int(sr), bounds


def write_srt(path: Path, bounds, total: float):
    lines = []
    for i, (st, en, txt) in enumerate(bounds, 1):
        nxt = (bounds[i][0] - 0.06) if i < len(bounds) else total
        end = min(en + 0.10, nxt - 0.02) if i < len(bounds) else min(en + 0.10, total)
        lines.append("%d\n%s --> %s\n%s\n" % (i, fmt_ts(max(0.0, st - 0.06)), fmt_ts(end), txt))
    path.write_text("\n".join(lines), encoding="utf-8")


def bank_dir() -> Path:
    p = Path(CONFIG["work_dir"]) / "voicebank"
    p.mkdir(parents=True, exist_ok=True)
    return p


def bank_load() -> dict:
    f = bank_dir() / "index.json"
    if f.exists():
        try:
            return json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def bank_save(data: dict):
    (bank_dir() / "index.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def bank_add(entry: dict) -> dict:
    data = bank_load()
    name = entry["name"]
    base = name
    i = 2
    while name in data:
        name = "%s-%d" % (base, i)
        i += 1
    entry["name"] = name
    entry["created"] = time.strftime("%Y-%m-%d %H:%M:%S")
    data[name] = entry
    bank_save(data)
    return entry


def separate_media(src: Path, out: Path) -> dict:
    import audio_separator.separator.separator as S
    orig = S.Separator.download_file_if_not_exists
    mirrors = ("https://ghfast.top/", "https://ghproxy.net/")

    def patched(self, url, *a, **k):
        try:
            return orig(self, url, *a, **k)
        except Exception:
            last = None
            for m in mirrors:
                try:
                    return orig(self, m + url, *a, **k)
                except Exception as e:
                    last = e
            raise last

    S.Separator.download_file_if_not_exists = patched
    from audio_separator.separator import Separator
    out.mkdir(parents=True, exist_ok=True)
    sep = Separator(model_file_dir=CONFIG["uvr_models"], output_dir=str(out),
                    output_format="WAV", log_level=40)
    sep.load_model(model_filename=CONFIG.get("uvr_model", "UVR-MDX-NET-Voc_FT.onnx"))
    files = sep.separate(str(src))
    result = {}
    for f in files:
        p = out / f
        if "Vocals" in f:
            result["vocals"] = str(p)
        else:
            result["instrumental"] = str(p)
    return result


def pick_clean_segment(wav_path: Path, target: float = 9.0) -> dict:
    import numpy as np
    a, sr = load_wav(wav_path)
    win = int(target * sr)
    if len(a) <= win:
        seg, start = a, 0
    else:
        hop = max(1, win // 4)
        best, best_score = 0, -1.0
        for s in range(0, len(a) - win + 1, hop):
            chunk = a[s:s + win]
            rms = float(np.sqrt(np.mean(chunk ** 2)))
            if float(np.max(np.abs(chunk))) > 0.99:
                continue
            if rms > best_score:
                best, best_score = s, rms
        seg, start = a[best:best + win], best
    thr = max(1e-4, float(np.max(np.abs(seg))) * 0.02)
    idx = np.where(np.abs(seg) > thr)[0]
    if len(idx) > int(0.5 * sr):
        seg = seg[max(0, idx[0] - int(0.05 * sr)): idx[-1] + int(0.05 * sr)]
    return {"audio": seg, "sr": sr, "start_sec": round(start / sr, 2), "dur": round(len(seg) / sr, 2)}


def handle(req: str, body: dict) -> dict:
    if req == "health":
        idle = time.time() - STATE["last_activity"]
        return {"ok": True, "loaded": STATE["loaded"],
                "uptime_s": round(time.time() - STATE["started"], 1),
                "idle_s": round(idle, 1),
                "idle_shutdown_ms": CONFIG.get("idle_shutdown_ms", 300000)}
    if req == "shutdown":
        threading.Thread(target=lambda: (time.sleep(0.3), os._exit(0)), daemon=True).start()
        return {"ok": True, "bye": True}
    STATE["last_activity"] = time.time()

    if req == "say":
        voice = body["voice"]
        kind = body.get("kind") or voice.get("kind") or "custom"
        audio, sr, bounds = synth_sentences(kind, body["text"], voice, takes=int(body.get("takes", 1)), do_trim=bool(body.get("trim", True)))
        stem = body.get("stem") or ("tts-%d" % int(time.time()))
        target = Path(body["out_dir"]).expanduser() if body.get("out_dir") else out_dir()
        target.mkdir(parents=True, exist_ok=True)
        wav = target / (stem + ".wav")
        save_wav(wav, audio, sr)
        srt = target / (stem + ".srt")
        write_srt(srt, bounds, len(audio) / sr)
        return {"wav": str(wav), "srt": str(srt), "dur": round(len(audio) / sr, 2),
                "sr": sr, "sentences": len(bounds)}

    if req == "preview":
        items = body["items"]
        results = []
        for i, it in enumerate(items, 1):
            kind = it.get("kind", "custom")
            audio, sr, _ = synth_sentences(kind, body["text"], it["voice"])
            stem = body.get("stem") or ("cand-%d" % int(time.time()))
            wav = out_dir() / ("%s-%d.wav" % (stem, i))
            save_wav(wav, audio, sr)
            results.append({"index": i, "label": it.get("label", ""), "wav": str(wav),
                            "dur": round(len(audio) / sr, 2), "sr": sr,
                            "voice": it.get("voice"), "kind": kind})
        return {"candidates": results}

    if req == "timeline":
        import numpy as np
        items = body["items"]
        parts, bounds = [], []
        sr = 24000
        cursor = 0.0
        for it in items:
            kind = it.get("kind", "custom")
            audio, sr, seg = synth_sentences(kind, it["text"], it["voice"])
            for (st, en, txt) in seg:
                bounds.append((cursor + st, cursor + en, txt))
            parts.append(audio)
            parts.append(np.zeros(int(0.18 * sr), dtype=np.float32))
            cursor += len(audio) / sr + 0.18
        merged = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
        stem = body.get("stem") or ("tl-%d" % int(time.time()))
        wav = out_dir() / (stem + ".wav")
        save_wav(wav, merged, sr)
        srt = out_dir() / (stem + ".srt")
        write_srt(srt, bounds, len(merged) / sr)
        return {"wav": str(wav), "srt": str(srt), "dur": round(len(merged) / sr, 2),
                "sentences": len(bounds)}

    if req == "separate":
        src = Path(body["media"])
        res = separate_media(src, out_dir() / "sep")
        seg = pick_clean_segment(Path(res["vocals"]), float(body.get("target", 9.0)))
        clip = out_dir() / ("ref-%d.wav" % int(time.time()))
        save_wav(clip, seg["audio"], seg["sr"])
        ref_text = ""
        try:
            m = MODELS.get("asr")
            rr = m.transcribe(audio=str(clip), language="Chinese")
            ref_text = rr[0].text
            log("ref transcript:", ref_text[:60])
        except Exception as e:
            log("ref transcript failed", repr(e)[:120])
        return {"vocals": res["vocals"], "instrumental": res.get("instrumental"),
                "ref_clip": str(clip), "ref_dur": seg["dur"], "ref_start": seg["start_sec"],
                "ref_text": ref_text}

    if req == "asr_subs":
        model = MODELS.get("asr")
        res = model.transcribe(audio=body["audio"], language=body.get("language") or "Chinese")
        text = res[0].text.strip()
        a, sr = load_wav(Path(body["audio"]))
        bounds = allocate_bounds(text, a, sr)
        stem = body.get("stem") or ("asrsubs-%d" % int(time.time()))
        srt = out_dir() / (stem + ".srt")
        lines = []
        for i, (st, en, txt) in enumerate(bounds, 1):
            lines.append("%d\n%s --> %s\n%s\n" % (i, fmt_ts(st), fmt_ts(en), txt))
        srt.write_text("\n".join(lines), encoding="utf-8")
        return {"text": text, "cues": [{"start": round(st, 3), "end": round(en, 3), "text": t} for st, en, t in bounds], "srt": str(srt)}

    if req == "asr":
        model = MODELS.get("asr")
        res = model.transcribe(audio=body["audio"], language=body.get("language") or "Chinese")
        return {"text": res[0].text, "language": str(res[0].language)}

    if req == "bank_list":
        return {"entries": bank_load()}

    if req == "bank_add":
        return {"entry": bank_add(body["entry"])}

    raise ValueError("unknown request: " + req)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send(self, code: int, payload: dict):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send(200, handle("health", {}))
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            req = body.pop("req", "")
            with LOCK:
                result = handle(req, body)
            self._send(200, {"ok": True, **result})
        except Exception as e:
            log("ERROR", repr(e))
            log(traceback.format_exc()[:1500])
            self._send(500, {"ok": False, "error": str(e)[:400]})


def watchdog():
    limit = CONFIG.get("idle_shutdown_ms", 300000)
    if limit <= 0:
        return
    while True:
        time.sleep(10)
        idle = time.time() - STATE["last_activity"]
        if idle * 1000 >= limit:
            with LOCK:
                MODELS.free_all()
            log("idle %.0fs, exiting" % idle)
            os._exit(0)


def main():
    CONFIG.update(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")))
    sys.path.insert(0, CONFIG["libs"])
    port = int(CONFIG.get("port", 17321))
    log("dsh-tts service on", port, "work_dir=", CONFIG["work_dir"])
    threading.Thread(target=watchdog, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()