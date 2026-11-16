#!/usr/bin/env python3
"""交付版 → Android assets 的确定性同步（spec v7 §5 的同步规则）。

规则只有一条：**交付版是源，assets 是派生**。派生时只做「中文文件名 → ASCII 文件名」
的替换，别的一个字节都不许差。因此下面这张表就是唯一允许的差异来源。

用法：
    python scripts/sync-assets.py            # 写入 assets
    python scripts/sync-assets.py --check    # 只比对，有漂移则退出码 1（进 CI / 门禁）
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSET_DIR = os.path.join(ROOT, "android/app/src/main/assets/www")

# 交付版文件名 → App 内文件名。顺序无关，替换是整名匹配。
MAP = {
    "demo-首页.html": "home.html",
    "故事集-1到3岁.html": "age.html",
    "故事内页-走路这件事.html": "story.html",
    "搜索-演示.html": "search.html",
    "上传确认页.html": "upload.html",
    "故事卡片.html": "card.html",
    "演示总览.html": "index.html",
    "设计说明.html": "spec.html",
}
# 套壳预览.html 不进 App（它是讲壳层行为的文档），故意不在表里。


def derive(name):
    """读交付版（统一按 LF 读，避免 CRLF/LF 混用把差异算进来），只替换文件名。"""
    src_path = os.path.join(ROOT, name)
    with open(src_path, encoding="utf-8", newline=None) as fh:
        text = fh.read()
    for zh, ascii_name in MAP.items():
        text = text.replace(zh, ascii_name)
    return text


def main():
    check = "--check" in sys.argv
    drift, written = [], []

    for zh, ascii_name in MAP.items():
        if not os.path.exists(os.path.join(ROOT, zh)):
            drift.append(f"{zh}：交付版缺失")
            continue
        expected = derive(zh).encode("utf-8")
        target = os.path.join(ASSET_DIR, ascii_name)
        actual = open(target, "rb").read() if os.path.exists(target) else None

        if actual == expected:
            continue
        if check:
            if actual is None:
                drift.append(f"assets/{ascii_name}：缺失（应由 {zh} 派生）")
            else:
                a = actual.decode("utf-8").splitlines()
                e = expected.decode("utf-8").splitlines()
                diff = sum(1 for x, y in zip(a, e) if x != y) + abs(len(a) - len(e))
                hint = "（换行符不一致）" if a != e and [l.rstrip("\r") for l in a] == e else ""
                drift.append(f"assets/{ascii_name}：与 {zh} 不同（约 {diff} 行）{hint}")
        else:
            os.makedirs(ASSET_DIR, exist_ok=True)
            with open(target, "wb") as fh:
                fh.write(expected)
            written.append(f"assets/{ascii_name} ← {zh}")

    # 反向检查：assets 里有没有表外的孤儿页面
    known = set(MAP.values())
    for f in sorted(os.listdir(ASSET_DIR)):
        if f.endswith(".html") and f not in known:
            drift.append(f"assets/{f}：不在映射表里（孤儿文件）")

    if check:
        if drift:
            print("同步漂移 / DRIFT DETECTED")
            for d in drift:
                print("  ✗", d)
            return 1
        print(f"assets 与交付版一致（{len(MAP)} 个页面，仅文件名不同）")
        return 0

    if written:
        for w in written:
            print("  ✎", w)
        print(f"已同步 {len(written)} 个页面；其余已是最新")
    else:
        print("无需同步，assets 已是最新")
    return 0


if __name__ == "__main__":
    sys.exit(main())
