
# 英语便捷听读项目仓库

**单句点读**、**句子循环**、**自定义导入**、**字号调节**

---

### ✨ 更新后的功能
- **添加了导入功能**：根据自己的MP3和LRC导入操作自定义
- 🔁 **单句循环增强**：可设置循环次数（无限 / 2 / 3 / 5 / 10 次）与循环间隔时间（0 / 0.5 / 1 / 2 / 3 秒）
  - **单句循环**：每句按设定次数循环后自动进入下一句，整课逐句循环
  - **单句点读**：设定次数后点击句子按次数+间隔重复播放，播完停在句首；未设定次数则保持点读一遍的原行为
- 🔠 **字号调节**：控制栏字号按钮循环切换 5 档字号（小 / 标准 / 大 / 特大 / 最大），设置持久化
- 📱 **响应式设计**：手机、平板、电脑均可流畅使用

- 🐞 **修复**：倍速问题

---

- **前端**：HTML + CSS + JavaScript（纯静态实现）
- **默认音频来源**：美音音频来自 [tangx/New-Concept-English](https://github.com/tangx/New-Concept-English)

---

**原作者的在线体验**：👉 **[http://nce.ichochy.com](http://nce.ichochy.com)**

**原作者仓库GitHub**：https://github.com/ichochy/nce

---

## 🚀 本地运行（三种方式，任选其一）

### 方式一：双击 exe（推荐 · 电脑无需安装 Python）

1. 把 `NCE-Server.exe` 放在**项目根目录**（与 `index.html` 同级）。
2. 双击运行，会自动启动本地服务并打开浏览器。
3. 用完直接**关掉那个黑色窗口**即可停止服务。

> - 默认端口 8080；被占用时会自动顺延（8080 → 8081 …），窗口里会显示实际地址。
> - 想自己重新打包：`pip install pyinstaller`，然后执行 `python tools/build_exe.py`。
> - exe 约 9MB，默认已在 `.gitignore` 中忽略（避免每次打包都往 Git 历史塞二进制）。
>   要分享给别人，可直接发送这个 exe，或作为附件上传到 GitHub Release。

### 方式二：已安装 Python

```bash
python tools/server.py               # 默认 8080，并自动打开浏览器
python tools/server.py 9000          # 指定端口
python tools/server.py --no-browser  # 不自动打开浏览器
```

### 方式三：一键脚本（Windows）

- `start_py_server.bat`：先清理 8080 端口上的残留进程再启动（需要本机有 Python）。
- `start_npx_server.bat`：用 `npx serve` 启动（需要本机有 Node.js）。

---

## 📦 外挂资源

系统的核心设计：**播放器与资源完全解耦**。一份学习资源就是一个可静态托管的目录，包含 `book.json` 描述文件、每课的 MP3 音频与 LRC 歌词。

### 目录结构

```
your-book/
├── book.json          # 课本描述文件（必需）
├── cover.png          # 课本封面（可选）
├── unit1.mp3          # 课文音频
├── unit1.lrc          # 课文歌词（中英对照）
├── unit2.mp3
└── unit2.lrc
```

### book.json

```json
{
  "name": "新概念英语",
  "level": "1 st",
  "cover": "cover.png",
  "units": [
    { "title": "Unit 1 Hello", "filename": "unit1" },
    { "title": "Unit 2 Nice to meet you", "filename": "unit2" }
  ]
}
```

系统按 `${bookPath}/${filename}.mp3` 与 `${bookPath}/${filename}.lrc` 拼接资源地址。

### LRC 歌词格式

标准 LRC 时间标签，`|` 分隔英文与中文：

```
[00:12.34]Good morning, class. | 早上好，同学们。
[00:15.00]Stand up, please. | 请起立。
[00:18.50]Sit down, please. | 请坐。
```

- 时间标签支持 `[mm:ss.xx]` 或 `[mm:ss.xxx]`
- `|` 左侧为英文、右侧为中文（中文可省略）
- `#` 开头的行视为注释，空行自动忽略

### 接入自己的资源

1. **准备资源**：按上述结构生成 `book.json`、MP3 与 LRC 文件，托管到任意支持 CORS 的静态服务器（GitHub Pages、Vercel、OSS、Nginx 等）
2. **注册课本**：在 `data.json` 的 `books` 数组中添加一条记录：

   ```json
   {
     "key": "MYBOOK",
     "title": "My English Book",
     "path": "https://your-domain.com/your-book"
   }
   ```

3. **访问**：部署播放器后，通过 `https://your-player.com/#MYBOOK` 直达该课本

> ⚠️ 资源服务器需返回 CORS 头（如 `Access-Control-Allow-Origin: *`），否则浏览器会拦截跨域请求 `book.json` 与 LRC 文件。

---

### 🤝 如何贡献

欢迎大家一起完善这个项目！

- 提交 Issue 反馈翻译错误、功能建议
- Pull Request 改进代码、修正字幕、添加新功能
- 分享给更多英语学习者

