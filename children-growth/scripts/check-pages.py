#!/usr/bin/env python3
"""三条硬门禁 + 自包含检查（spec v7 FR-14 / plan v7 §9）。

用法：
    python scripts/check-pages.py            # 全量检查，失败退出码 1
    python scripts/check-pages.py --quiet    # 只输出失败项与汇总

门禁：
  1. 标签闭合      —— html.parser 比对开闭栈，报未闭合/多余标签及行号
  2. 内联 JS 语法  —— 抽出 <script> 内容，node --check
  3. 体积          —— 单页 ≤40KB、六个产品页合计 ≤120KB
  4. 可公开        —— 产物里不得出现凭据 / 预签名 URL / 本机绝对路径（FR-13）
另外：六个产品页必须自包含（不引外部 js/css、无 ES import）。
"""
import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 发给家人的六个页面（预算与自包含只管这六个）
PRODUCT_PAGES = [
    "demo-首页.html",
    "故事集-1到3岁.html",
    "故事内页-走路这件事.html",
    "搜索-演示.html",
    "上传确认页.html",
    "故事卡片.html",
]
# 文档页：只查闭合与语法，不计预算
DOC_PAGES = ["演示总览.html", "设计说明.html", "套壳预览.html"]
ASSET_DIR = os.path.join(ROOT, "android/app/src/main/assets/www")

PAGE_MAX_KB = 40
TOTAL_MAX_KB = 120

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input",
        "link", "meta", "param", "source", "track", "wbr"}


class Balance(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.errors = []

    def handle_starttag(self, tag, attrs):
        if tag not in VOID:
            self.stack.append((tag, self.getpos()[0]))

    def handle_startendtag(self, tag, attrs):
        pass

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if not self.stack:
            self.errors.append(f"第 {self.getpos()[0]} 行：多余的 </{tag}>")
            return
        if self.stack[-1][0] == tag:
            self.stack.pop()
            return
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                inner = "、".join(t for t, _ in self.stack[i + 1:])
                self.errors.append(
                    f"第 {self.getpos()[0]} 行：</{tag}> 之前未闭合 [{inner}]")
                del self.stack[i:]
                return
        self.errors.append(f"第 {self.getpos()[0]} 行：孤立的 </{tag}>")


def gate_balance(path):
    parser = Balance()
    parser.feed(open(path, encoding="utf-8").read())
    errs = list(parser.errors)
    if parser.stack:
        errs.append("文件结束仍有未闭合：" + "、".join(t for t, _ in parser.stack))
    return errs


def gate_js(path):
    src = open(path, encoding="utf-8").read()
    blocks = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", src, re.S)
    js = "\n;\n".join(b for b in blocks if b.strip())
    if not js.strip():
        return []
    if not shutil.which("node"):
        return ["未安装 node，无法校验内联脚本"]
    tmp = os.path.join(tempfile.gettempdir(), "_gate_check.js")
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(js)
    r = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
    if r.returncode == 0:
        return []
    first = (r.stderr or "").strip().splitlines()
    return ["内联 JS 语法错误：" + (first[0] if first else "node --check 失败")]


def gate_selfcontained(path):
    src = open(path, encoding="utf-8").read()
    errs = []
    if re.search(r"<script[^>]+\bsrc=", src):
        errs.append("引用了外部 <script src>")
    if re.search(r"<link[^>]+rel=[\"']stylesheet", src):
        errs.append("引用了外部样式表")
    if re.search(r"^\s*import\s.+\sfrom\s", src, re.M) or "@import" in src:
        errs.append("使用了 ES import / @import")
    if re.search(r"<script[^>]+type=[\"']module", src):
        errs.append("使用了 type=module")
    return errs


# 公开产物不许出现的东西（spec v7 FR-13「页面无凭据」）
FORBIDDEN = [
    (re.compile(r"X-Amz-Signature|X-Amz-Credential"), "出现预签名 URL 参数"),
    (re.compile(r"(?i)\b(secret|password|passwd|access[_-]?key)\b\s*[:=]"), "出现密钥字样"),
    (re.compile(r"(?i)bearer\s+[A-Za-z0-9._-]{12,}"), "出现 Bearer token"),
    (re.compile(r"file:///"), "出现本地 file:// 路径"),
    (re.compile(r"[A-Za-z]:[\\/]Users[\\/]"), "出现本机绝对路径"),
]


def gate_publishable(path):
    src = open(path, encoding="utf-8").read()
    return [f"{why}（第 {src[:m.start()].count(chr(10)) + 1} 行）" for m, why in
            ((rx.search(src), why) for rx, why in FORBIDDEN) if m]


def kb(path):
    return os.path.getsize(path) / 1024.0


def main():
    quiet = "--quiet" in sys.argv
    failures = []

    targets = [(p, True) for p in PRODUCT_PAGES] + [(p, False) for p in DOC_PAGES]
    total = 0.0
    printed = []

    for name, is_product in targets:
        path = os.path.join(ROOT, name)
        if not os.path.exists(path):
            failures.append(f"{name}：文件不存在")
            continue
        errs = gate_balance(path) + gate_js(path)
        if is_product:
            errs += gate_selfcontained(path) + gate_publishable(path)
            size = kb(path)
            total += size
            if size > PAGE_MAX_KB:
                errs.append(f"体积 {size:.1f}KB 超过单页上限 {PAGE_MAX_KB}KB")
            printed.append((name, size, "产品页"))
        else:
            printed.append((name, kb(path), "文档页（不计预算）"))
        for e in errs:
            failures.append(f"{name}：{e}")

    # assets 目录里的同名页面也要能过（它们是发到 App 里的那份）
    for path in sorted(glob.glob(os.path.join(ASSET_DIR, "*.html"))):
        errs = gate_balance(path) + gate_js(path) + gate_publishable(path)
        for e in errs:
            failures.append(f"assets/{os.path.basename(path)}：{e}")

    if total > TOTAL_MAX_KB:
        failures.append(
            f"六页合计 {total:.1f}KB 超过上限 {TOTAL_MAX_KB}KB（超 {total - TOTAL_MAX_KB:.1f}KB）")

    if not quiet:
        print("页面体积 / size report")
        for name, size, kind in printed:
            print(f"  {name:<26} {size:6.1f} KB   {kind}")
        print(f"  {'产品页合计':<24} {total:7.1f} KB   / 上限 {TOTAL_MAX_KB}KB，单页上限 {PAGE_MAX_KB}KB")
        print()

    if failures:
        print("门禁失败 / GATE FAILED")
        for f in failures:
            print("  ✗", f)
        return 1

    print("四条门禁全部通过 / all gates passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
