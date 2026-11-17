# 由 bootstrap_env.py 复制到依赖目录，作为 pysox 的替身。
# 原来这份文件只存在于 _tts_probe/pylibs/sox.py（不在版本库里），换机器就丢，
# 这也是"环境复现不了"的一环。现在收进仓库。
#
(Qwen3TTSTokenizerV1), which the 12Hz models never execute. No sox binary
is available here, so we expose just enough surface for the import to succeed.
"""


class Transformer:
    def __init__(self, *args, **kwargs):
        raise RuntimeError("pysox stub: sox binary not available")


class Core:
    def __init__(self, *args, **kwargs):
        raise RuntimeError("pysox stub: sox binary not available")


def file_info(*args, **kwargs):
    raise RuntimeError("pysox stub: sox binary not available")
