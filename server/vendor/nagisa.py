"""nagisa 的替身。

为什么需要它：nagisa 0.2.11 是 qwen-asr 的依赖，但它在 Windows 上装得上、
导入必崩（ModuleNotFoundError: No module named 'dynet_config'——那是 dyNET
编译期产物，Windows 没有预编译包）。

qwen-asr 只在「日文强制对齐」里用它一次：

    words = nagisa.tagging(text).words      # qwen3_forced_aligner.py:102

所以只要 tagging(text).words 能给出「词」就行。这里按语言常识切：
- 汉字/假名/韩文：每个字一个词（和中文对齐器逐字吐的做法一致）
- 拉丁字母/数字：连续的一段算一个词
- 标点与空白：单独成词，交给下游 clean_token 过滤

这不是真正的形态素分析，但比空列表强得多：至少能对齐，也能给出断点位置。
"""

import re
import unicodedata

_LATIN = re.compile(r"[A-Za-z0-9_]+(?:['’\-][A-Za-z0-9_]+)*")


def _is_cjk(ch: str) -> bool:
    code = ord(ch)
    return (
        0x3040 <= code <= 0x30FF      # 假名
        or 0x3400 <= code <= 0x4DBF   # 汉字扩展 A
        or 0x4E00 <= code <= 0x9FFF   # 汉字
        or 0xF900 <= code <= 0xFAFF   # 兼容汉字
        or 0xAC00 <= code <= 0xD7AF   # 韩文音节
        or 0x1100 <= code <= 0x11FF   # 韩文字母
    )


def segment(text: str) -> list:
    """把文本切成词列表。"""
    s = str(text or "")
    out = []
    i = 0
    n = len(s)
    while i < n:
        ch = s[i]
        m = _LATIN.match(s, i)
        if m:
            out.append(m.group(0))
            i = m.end()
            continue
        if _is_cjk(ch):
            out.append(ch)
            i += 1
            continue
        if ch.isspace():
            out.append(ch)
            i += 1
            continue
        out.append(ch)
        i += 1
    return out


class Tagging:
    """模仿 nagisa.Tagging 的最小接口。"""

    def __init__(self, text: str):
        self.text = str(text or "")
        self.words = segment(self.text)
        self.postags = ["UNK"] * len(self.words)
        self.tags = list(self.postags)

    def __len__(self):
        return len(self.words)

    def __repr__(self):
        return "Tagging(%r, %d words)" % (self.text[:20], len(self.words))


def tagging(text: str) -> Tagging:
    return Tagging(text)


def wakati(text: str) -> str:
    return " ".join(w for w in segment(text) if w.strip())


def normalize(text: str) -> str:
    return unicodedata.normalize("NFKC", str(text or ""))
