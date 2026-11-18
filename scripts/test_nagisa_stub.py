"""nagisa 替身的单元测试。运行：python scripts/test_nagisa_stub.py"""
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
STUB = HERE.parent / "server" / "vendor" / "nagisa.py"

spec = importlib.util.spec_from_file_location("nagisa_stub", STUB)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

fail = 0


def ok(cond, label, extra=None):
    global fail
    if cond:
        print("  ok   " + label)
    else:
        fail += 1
        print("  FAIL " + label + (" -> %r" % (extra,) if extra is not None else ""))


print("[1] 日文按字切")
t = mod.tagging("おはようございます。")
ok(t.words[:3] == ["お", "は", "よ"], "假名逐字", t.words[:5])
ok("。" in t.words, "标点保留成词", t.words)

print("[2] 拉丁按词切")
t2 = mod.tagging("Good morning, Mr. Smith!")
ok("Good" in t2.words and "morning" in t2.words, "英文按词", t2.words)
ok("Smith" in t2.words, "专有名词完整", t2.words)

print("[3] 混排与数字")
t3 = mod.tagging("3.5 km 東京")
ok("3" in t3.words and "5" in t3.words and "km" in t3.words, "数字与单位分开", t3.words)
ok("東" in t3.words and "京" in t3.words, "汉字逐字", t3.words)

print("[4] 接口形状")
ok(hasattr(t, "postags") and len(t.postags) == len(t.words), "postags 等长", len(t.postags))
ok(hasattr(t, "tags") and len(t.tags) == len(t.words), "tags 等长")
ok(len(t) == len(t.words), "__len__ 与 words 一致")
ok(mod.wakati("東京都") == "東 京 都", "wakati 用空格连回去", mod.wakati("東京都"))

print("[5] 空输入不炸")
ok(mod.tagging("").words == [], "空串返回空列表")
ok(mod.tagging(None).words == [], "None 也不炸")

print("")
print("全部通过" if fail == 0 else "%d 项失败" % fail)
sys.exit(0 if fail == 0 else 1)
