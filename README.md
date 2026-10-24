
# 英语便捷听读项目仓库

**单句点读**、**句子循环**、**自定义导入**、**字号调节**、**全屏字幕**

---

### ✨ 更新后的功能
- **添加了导入功能**：根据自己的音频和字幕导入操作自定义
- 🎧 **多格式支持**：音频 `mp3 / m4a / wav / flac`，字幕 `lrc / srt / vtt`（同一课本内可混用，按文件名自动配对）
- 🔁 **单句循环增强**：可设置循环次数（无限 / 2 / 3 / 5 / 10 次）与循环间隔时间（0 / 0.5 / 1 / 2 / 3 秒 / **各句子本身时长**）
  - 「各句子本身时长」会按当前句子的时长停顿，句子长就停得久、短就停得短，适合跟读；该时长按原始时间差计时，不随播放倍速缩放
  - SRT / VTT 自带结束时间，直接用它；LRC 没有结束时间，用下一句的起始时间推算
  - **单句循环**：每句按设定次数循环后自动进入下一句，整课逐句循环
  - **单句点读**：设定次数后点击句子按次数+间隔重复播放，播完停在句首；未设定次数则保持点读一遍的原行为
- 🔠 **字号调节**：控制栏字号按钮循环切换 5 档字号（小 / 标准 / 大 / 特大 / 最大），设置持久化
- 🖥 **全屏字幕**：控制栏全屏按钮进入全屏，居中大字显示「上一句 / 当前句 / 下一句」
  - 底部浮动一整套播放控件（进度条可拖动、播放/暂停、上一句/下一句、倍速、退出）与字号滑块
  - 鼠标静止 3 秒自动隐藏控件与滑块（连鼠标指针一起隐藏），移动鼠标即恢复
  - 字号滑块 0.6x ~ 3x 独立记忆，不影响列表字号；支持 Esc 退出
- ⌨️ **键盘快捷键**：`空格` 播放 / 暂停、`PageUp` 上一课、`PageDown` 下一课
  - 翻页键与导航区的上一课 / 下一课按钮走同一条路径，到首课 / 末课时同样不响应；
    焦点在输入框、文本域、下拉框里时不拦截，避免影响正常输入
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

系统的核心设计：**播放器与资源完全解耦**。一份学习资源就是一个可静态托管的目录，包含 `book.json` 描述文件、每课的音频与字幕。

**支持的格式**：音频 `mp3` / `m4a` / `wav` / `flac`，字幕 `lrc` / `srt` / `vtt`。

### 目录结构

```
your-book/
├── book.json          # 课本描述文件（必需）
├── cover.png          # 课本封面（可选）
├── unit1.mp3          # 课文音频（也可以是 m4a / wav / flac）
├── unit1.lrc          # 课文字幕（也可以是 srt / vtt）
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

**扩展名怎么定**：`filename` 不带扩展名，系统用第一课探测实际格式（mp3 > m4a > wav > flac、lrc > srt > vtt），整本复用探测结果。也就是说**整本课本的格式需要统一**；如果某一课确实用了别的格式，可以在该课里写死文件名（支持相对路径或完整 URL）：

```json
{ "title": "Unit 3", "filename": "unit3", "audio": "unit3.m4a", "lrc": "unit3.vtt" }
```

> 探测依赖服务器正确处理 `HEAD` 请求。若服务器不支持，`book.json` 探测全部失败时会退回 `mp3` + `lrc`（与旧版行为一致）。

### 字幕格式

三种格式会自动识别，无需配置：

#### LRC

标准 LRC 时间标签，`|` 分隔英文与中文：

```
[00:12.34]Good morning, class. | 早上好，同学们。
[00:15.00]Stand up, please. | 请起立。
[00:18.50]Sit down, please. | 请坐。
```

- 时间标签支持 `[mm:ss.xx]` 或 `[mm:ss.xxx]`
- `|` 左侧为英文、右侧为中文（中文可省略）
- `#` 开头的行视为注释，空行自动忽略

#### SRT

```
1
00:00:12,340 --> 00:00:15,000
Good morning, class.
早上好，同学们。

2
00:00:15,000 --> 00:00:18,500
Stand up, please.
请起立。
```

#### VTT

```
WEBVTT

00:12.340 --> 00:15.000
Good morning, class.
早上好，同学们。
```

SRT / VTT 的通用规则：

- 时间戳分隔符 `,`（SRT）与 `.`（VTT）都认，VTT 的 `MM:SS.mmm` 简写也支持
- 结束时间之后的 cue 定位参数（`align:start position:10%`）会被忽略
- `<v Speaker>` / `<i>` 之类的标记与 `{\an8}` 定位标记会被剥掉
- VTT 的 `NOTE` / `STYLE` / `REGION` 块不会变成字幕
- **双语判定**：优先按文本里的 `|` 分隔；没有 `|` 时，第一个含中日韩字符的行及其之后算中文，之前的算英文。这样换行的英文不会被误判成中文
- LRC 只有起始时间，句子结束时间用下一句推算；SRT / VTT 自带结束时间，直接用（「各句子本身时长」的停顿也因此更准）

### 接入自己的资源

1. **准备资源**：按上述结构生成 `book.json`、音频与字幕文件，托管到任意支持 CORS 的静态服务器（GitHub Pages、Vercel、OSS、Nginx 等）
2. **注册课本**：在 `data.json` 的 `books` 数组中添加一条记录：

   ```json
   {
     "key": "MYBOOK",
     "title": "My English Book",
     "path": "https://your-domain.com/your-book"
   }
   ```

3. **访问**：部署播放器后，通过 `https://your-player.com/#MYBOOK` 直达该课本

> 📌 同一个 `key` 可以注册多个来源（例如 NCE1 同时配本地目录和几个镜像站）。程序会自动给它们生成唯一 id：首次出现的 key 直接用 `key` 本身，其余追加来源后缀（镜像站用域名，如 `NCE1-aonzey.github.io`）。下拉框、URL hash 与「上次选择的课本」都按 id 记录，因此选中第二个来源不会被第一个顶掉；学习进度仍按 `key` 存，同一册换镜像站不会丢失进度。也可以在 `data.json` 里手写 `"id"` 指定。

> ⚠️ 资源服务器需返回 CORS 头（如 `Access-Control-Allow-Origin: *`），否则浏览器会拦截跨域请求 `book.json` 与字幕文件。
>
> ⚠️ 服务器的 `Content-Type` 建议给音频返回正确的 MIME（`audio/mpeg` / `audio/mp4` / `audio/wav` / `audio/flac`）。浏览器一般能嗅探，但个别服务器回 `application/octet-stream` 时可能拒绝解码。自带的 `tools/server.py` 已显式配置好这些类型。

---

### 🤝 如何贡献

欢迎大家一起完善这个项目！

- 提交 Issue 反馈翻译错误、功能建议
- Pull Request 改进代码、修正字幕、添加新功能
- 分享给更多英语学习者

