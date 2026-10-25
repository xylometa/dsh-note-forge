#!/usr/bin/env python3
"""dsh-note-forge 的 PDF 后端：按题注切图 + 按页导出文本（JSON）。

    python3 forge.py figures --pdf a.pdf --chapter 5 --out 图5 --dpi 300 --pages 1-30
    python3 forge.py dump    --pdf a.pdf --pages 1-30

figures 输出每行一个 JSON：{"page":15,"caption":"图5-11 肺换气和组织换气示意图","file":"图5-11 ....png"}
dump 输出一个 JSON 数组：[{"page":1,"text":"..."}]
"""
import argparse, json, re, sys, pathlib

import pymupdf


def clean(name):
    name = re.sub(r'[\\/:*?"<>|]', " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name[:60]


def page_range(spec, count):
    if not spec:
        return 0, count
    a, _, b = spec.partition("-")
    return max(0, int(a) - 1), min(count, int(b or a))


def cmd_dump(a):
    doc = pymupdf.open(a.pdf)
    first, last = page_range(a.pages, doc.page_count)
    out = [{"page": p + 1, "text": doc[p].get_text("text")} for p in range(first, last)]
    json.dump(out, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def cmd_figures(a):
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open(a.pdf)
    first, last = page_range(a.pages, doc.page_count)

    cap_re = re.compile(rf"^图\s*{a.chapter}\s*-\s*(\d+)")
    body_re = re.compile(rf"^图\s*{a.chapter}\s*-\s*\d+\s*中")
    found = {}

    for pno in range(first, last):
        page = doc[pno]
        blocks = page.get_text("dict")["blocks"]
        tb = [b for b in blocks if b["type"] == 0]
        imgs = [pymupdf.Rect(i["bbox"]) for i in page.get_image_info()]

        # 先把本页所有题注按 y 排好：一页上下叠两张图时，靠「上一题注底边」当下边界，
        # 否则下面那张会把上面的图连同题注一起裁进去（图6-9 踩过）。
        caps = []
        for b in tb:
            if not b["lines"]:
                continue
            line0 = "".join(sp["text"] for sp in b["lines"][0]["spans"]).strip()
            m = cap_re.match(line0)
            if m and not body_re.match(line0):
                caps.append((pymupdf.Rect(b["bbox"]), int(m.group(1)), b))
        caps.sort(key=lambda c: (c[0].y0, c[0].x0))

        for cap, capnum, b in caps:
            num = capnum
            if num in found:
                continue
            line0 = "".join(sp["text"] for sp in b["lines"][0]["spans"]).strip()
            cap_text = "".join("".join(s["text"] for s in ln["spans"]) for ln in b["lines"]).strip()
            first_line = "".join(s["text"] for s in b["lines"][0]["spans"]).strip()

            # 同一列上方最近的那条题注，是这张图的上边界
            prev_cap_bottom = None
            for c2, _n2, _b2 in caps:
                if c2 is cap or c2.y1 > cap.y0 - 2:
                    continue
                if min(c2.x1, cap.x1) - max(c2.x0, cap.x0) <= 0:
                    continue
                if prev_cap_bottom is None or c2.y1 > prev_cap_bottom:
                    prev_cap_bottom = c2.y1
            floor_y = (prev_cap_bottom + 2) if prev_cap_bottom else -1

            above = [
                r for r in imgs
                if r.y1 <= cap.y0 + 2 and r.y0 >= floor_y and r.width > 60 and r.height > 60
                and min(r.x1, cap.x1) - max(r.x0, cap.x0) > 0.5 * min(r.width, cap.width)
            ]
            region = None
            if above:
                region = above[0]
                for r in above[1:]:
                    region |= r
                region = pymupdf.Rect(region.x0 - 3, region.y0 - 3, region.x1 + 3, region.y1 + 3)

            prev_bottom = None
            for b2 in tb:
                r = pymupdf.Rect(b2["bbox"])
                if r.y1 <= cap.y0 - 4 and r.x1 > cap.x0 - 40 and r.x0 < cap.x1 + 40:
                    if prev_bottom is None or r.y1 > prev_bottom:
                        prev_bottom = r.y1
            fallback_top = max((prev_bottom + 3) if prev_bottom else 0, floor_y)
            if region is None:
                region = pymupdf.Rect(cap.x0 - 40, fallback_top, cap.x1 + 40, cap.y0 - 2)
            else:
                region = pymupdf.Rect(region.x0, min(region.y0, fallback_top), region.x1, cap.y0 - 2)

            # 文件名只用题注首行，去掉冒号后的测定条件、和（A）（B）之类分图说明
            title = re.sub(rf"^图\s*{a.chapter}\s*-\s*\d+\s*", "", first_line) or cap_text
            title = re.split(r"[：:]", title)[0].strip() or title
            title = re.sub(r"\s*[（(][A-Za-z0-9一二三四五六]{1,3}[）)]\s*$", "", title)  # 去掉 （A）（B）这类分图号
            if "示意图" in title and len(title) <= 26:
                title = title.split("示意图")[0] + "示意图"
            elif len(title) > 26:
                cut = max(title.rfind("，", 0, 26), title.rfind("。", 0, 26), title.rfind("；", 0, 26))
                title = (title[:cut] if cut > 8 else title[:26]).rstrip("，。；、 ") + "…"

            fn = f"图{a.chapter}-{num} {clean(title)}.png"
            found[num] = {"page": pno + 1, "caption": f"图{a.chapter}-{num} {title}".strip(), "file": fn}
            if not a.list:
                page.get_pixmap(dpi=a.dpi, clip=region).save(str(out / fn))

    holes = [n for n in range(1, max(found) + 1) if n not in found] if found else []
    for num in sorted(found):
        print(json.dumps(found[num], ensure_ascii=False))
    print(json.dumps({"summary": {"count": len(found), "holes": holes, "out": str(out)}}, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("figures")
    f.add_argument("--pdf", required=True)
    f.add_argument("--chapter", required=True)
    f.add_argument("--out", default=".")
    f.add_argument("--pages", default=None)
    f.add_argument("--dpi", type=int, default=300)
    f.add_argument("--list", action="store_true")
    f.set_defaults(fn=cmd_figures)

    d = sub.add_parser("dump")
    d.add_argument("--pdf", required=True)
    d.add_argument("--pages", default=None)
    d.set_defaults(fn=cmd_dump)

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
