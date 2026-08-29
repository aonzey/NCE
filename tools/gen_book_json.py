# -*- coding: utf-8 -*-
"""Scan E:\\nce_mp3_and_lrc\\NCE{1-4} and generate book.json for each book."""
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

def main():
    for book_dir in sorted(ROOT.iterdir()):
        if not book_dir.is_dir() or book_dir.name not in LEVELS:
            continue
        mp3_files = sorted(book_dir.glob("*.mp3"))
        units = []
        for mp3 in mp3_files:
            base = mp3.stem  # e.g. "001&002－Excuse Me" or "003&004－Sorry, Sir."
            lrc = mp3.with_suffix(".lrc")
            if not lrc.exists():
                print(f"[WARN] missing lrc: {lrc.name}")
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
