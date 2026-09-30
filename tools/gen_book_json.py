# -*- coding: utf-8 -*-
"""Scan E:\\nce_mp3_and_lrc\\NCE{1-4} and generate book.json for each book.

音频与字幕都支持多种格式：音频 mp3/m4a/wav/flac，字幕 lrc/srt/vtt。
book.json 里只写不带扩展名的 filename，实际扩展名由前端探测（见 BookService）。
"""
import json
import re
from pathlib import Path

ROOT = Path(r"E:\nce_mp3_and_lrc")

LEVELS = {
    "NCE1": "1st Level",
    "NCE2": "2nd Level",
    "NCE3": "3rd Level",
    "NCE4": "4th Level",
}

# 顺序即优先级：同一课有多份时取靠前的那个
AUDIO_EXTS = ["mp3", "m4a", "wav", "flac"]
SUBTITLE_EXTS = ["lrc", "srt", "vtt"]


def find_with_exts(directory, stem, exts):
    """按优先级返回第一个存在的 <stem>.<ext> 路径，都不存在返回 None。"""
    for ext in exts:
        candidate = directory / f"{stem}.{ext}"
        if candidate.exists():
            return candidate
    return None


def main():
    for book_dir in sorted(ROOT.iterdir()):
        if not book_dir.is_dir() or book_dir.name not in LEVELS:
            continue

        # 收集所有音频的 stem（去重、排序）
        stems = sorted({
            p.stem
            for ext in AUDIO_EXTS
            for p in book_dir.glob(f"*.{ext}")
        })

        units = []
        for base in stems:  # e.g. "001&002－Excuse Me" or "003&004－Sorry, Sir."
            if not find_with_exts(book_dir, base, SUBTITLE_EXTS):
                print(f"[WARN] missing subtitle: {base}.* ({'/'.join(SUBTITLE_EXTS)})")
                continue
            # title: strip leading lesson numbers and separator (fullwidth dash / dot)
            m = re.match(r"^[0-9&]+[－.\-]?\s*(.*)$", base)
            title = m.group(1).strip() if m else base
            title = title.rstrip(".").strip()
            if not title:
                title = base
            units.append({"title": title, "filename": base})

        book_json = {
            "name": "New Concept English",
            "level": LEVELS[book_dir.name],
            "units": units,
        }
        out = book_dir / "book.json"
        out.write_text(json.dumps(book_json, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[OK] {book_dir.name}: {len(units)} units -> {out}")

if __name__ == "__main__":
    main()
