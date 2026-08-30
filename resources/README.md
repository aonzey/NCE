# resources 目录说明

这里放课本的音频（`.mp3`）与歌词（`.lrc`），页面默认读取本目录的内容
（见根目录 `data.json`，默认指向 `resources/NCE1` ~ `resources/NCE4`）。

## 目录约定

```
resources/
├── NCE1/
│   ├── book.json          # 课程清单（必需）
│   ├── 001&002－Excuse Me.mp3
│   ├── 001&002－Excuse Me.lrc
│   └── ...
├── NCE2/
├── NCE3/
└── NCE4/
```

同一课的 mp3 与 lrc **文件名必须相同**（仅扩展名不同），程序按文件名自动配对。

## book.json 格式

每个课本目录下需要一个 `book.json`，描述该册包含哪些课程：

```json
{
  "name": "NCE",
  "level": "1st Level",
  "cover": "NCE1.jpg",
  "units": [
    { "title": "001&002.Excuse Me", "filename": "001&002.Excuse Me" },
    { "title": "003&004.Sorry, Sir", "filename": "003&004.Sorry, Sir" }
  ]
}
```

- `filename` 不带扩展名，程序会自动拼接 `.mp3` 与 `.lrc`
- `title` 为课程列表中显示的标题
- `cover` 可选，放在同一目录

## 自动生成 book.json

目录下已有 mp3/lrc 时，可用脚本扫描生成：

```bash
python tools/gen_book_json.py
```

## 不想自己准备资源？

可以直接用页面右上角的**导入**按钮，支持文件夹批量、多选文件、ZIP 包、
`book.json` URL 四种方式，导入的内容保存在浏览器 IndexedDB 中，刷新不丢。

## 注意

本目录只提交结构与说明文档，你放入的 mp3 / lrc / 封面 / book.json 不会被
提交到 Git（已在中 `.gitignore` 忽略）。
