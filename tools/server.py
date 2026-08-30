import argparse
import os
import re
import socket
import sys
import threading
import webbrowser
from email.utils import mktime_tz, parsedate_tz
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, urlunsplit

def _default_port():
    """兼容老的调用方式 `server.py 8080`。

    这里不能直接 int(sys.argv[1])：像 --no-browser、--help 这种非数字参数
    会在模块加载阶段就抛 ValueError 直接崩掉，连 argparse 都跑不到。
    非数字参数一律回退到 8080，交由下面的 argparse 统一处理。
    """
    if len(sys.argv) > 1:
        try:
            return int(sys.argv[1])
        except ValueError:
            pass
    return 8080


PORT = _default_port()


def project_root():
    """返回要对外提供服务的目录（项目根目录，含 index.html / data.json）。

    - 打包成 exe（PyInstaller --onefile）时：以 exe 文件所在目录为准。
      这样无论从哪个工作目录双击或启动，都能正确读到页面与音频，
      而不是解压到临时目录里的 _MEIPASS。
    - 以源码方式运行（python tools/server.py）时：取 tools/ 的上一级目录，
      即项目根目录，与过去 `cd 项目根目录` 再启动的行为一致。
    """
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


ROOT = project_root()

# 只监听本机回环地址，外部机器访问不到，避免把本地资料暴露到局域网
BIND_HOST = "127.0.0.1"

# 开发用文件：禁止缓存，改完刷新即生效
NO_CACHE_EXT = {".html", ".htm", ".js", ".mjs", ".css", ".json", ".map"}
# 媒体等大文件：允许缓存 + 支持 304，避免每次循环/seek 全量重传
MEDIA_MAX_AGE = 300

RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


def parse_http_date(value):
    """解析 HTTP-date，失败返回 None。"""
    try:
        return mktime_tz(parsedate_tz(value))
    except (TypeError, ValueError, IndexError):
        return None


class _RangeReader:
    """只向外暴露 [start, end] 区间的文件读取器。"""

    def __init__(self, fileobj, remaining):
        self._fileobj = fileobj
        self._remaining = remaining

    def read(self, size=-1):
        if self._remaining <= 0:
            return b""
        if size is None or size < 0 or size > self._remaining:
            size = self._remaining
        data = self._fileobj.read(size)
        self._remaining -= len(data)
        return data

    def close(self):
        try:
            self._fileobj.close()
        finally:
            self._fileobj = None


class NoCacheHandler(SimpleHTTPRequestHandler):
    server_version = "NCEServer/1.1"
    # 开启 keep-alive：所有响应都带 Content-Length，安全
    protocol_version = "HTTP/1.1"

    # ---------------- 缓存 / 能力声明 ----------------
    def end_headers(self):
        try:
            ext = os.path.splitext(self.translate_path(self.path))[1].lower()
        except Exception:
            ext = ""
        if ext in NO_CACHE_EXT:
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        else:
            self.send_header("Cache-Control", "public, max-age=%d" % MEDIA_MAX_AGE)
        # 告诉浏览器"我支持断点续传 / seek"
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("[nce] %s - %s\n" % (self.address_string(), fmt % args))

    # ---------------- 校验器（ETag / Last-Modified） ----------------
    @staticmethod
    def _make_etag(st):
        return '"%x-%x"' % (int(st.st_mtime), st.st_size)

    @staticmethod
    def _strip_etag(tag):
        tag = tag.strip()
        if tag.startswith("W/"):      # 弱校验：去掉 W/ 前缀后比较
            tag = tag[2:].strip()
        if len(tag) >= 2 and tag[0] == '"' and tag[-1] == '"':
            tag = tag[1:-1]
        return tag

    def _etag_match(self, header_value, etag):
        """If-None-Match 支持逗号分隔列表与 '*'。"""
        if header_value.strip() == "*":
            return True
        wanted = self._strip_etag(etag)
        for candidate in header_value.split(","):
            if self._strip_etag(candidate) == wanted:
                return True
        return False

    def _is_not_modified(self, etag, st):
        """条件 GET 判定：命中返回 True（应回 304）。"""
        if self.command not in ("GET", "HEAD"):
            return False

        # RFC 7232：有 If-None-Match 时忽略 If-Modified-Since
        inm = self.headers.get("If-None-Match")
        if inm is not None:
            return self._etag_match(inm, etag)

        ims = self.headers.get("If-Modified-Since")
        if ims is not None:
            since = parse_http_date(ims)
            if since is not None and int(st.st_mtime) <= since:
                return True
        return False

    def _range_valid(self, etag, st):
        """If-Range 校验：不匹配则忽略 Range，回退为 200 全量。"""
        val = self.headers.get("If-Range")
        if val is None:
            return True
        val = val.strip()
        if val.startswith('"') or val.startswith("W/"):
            # If-Range 用强比较（不允许弱校验）
            return val == etag
        ts = parse_http_date(val)
        return ts is not None and int(st.st_mtime) == ts

    # ---------------- Range 解析 ----------------
    def _parse_range(self, file_size):
        """返回 (start, end) / "unsatisfiable" / None(不支持或多段,退化为 200)。"""
        header = self.headers.get("Range")
        if not header:
            return None
        match = RANGE_RE.match(header.strip())
        if not match:  # 多段 Range / 其他单位，不支持，返回整个文件
            return None

        start_s, end_s = match.group(1), match.group(2)
        if start_s == "" and end_s == "":
            return None

        if start_s == "":  # bytes=-N  取最后 N 字节
            length = int(end_s)
            if length == 0:
                return None
            start, end = max(0, file_size - length), file_size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else file_size - 1

        if start >= file_size or start > end:
            return "unsatisfiable"
        return start, min(end, file_size - 1)

    # ---------------- 核心：send_head ----------------
    def send_head(self):
        path = self.translate_path(self.path)

        if os.path.isdir(path):
            parts = urlsplit(self.path)
            if not parts.path.endswith("/"):
                # 补尾斜杠，否则页面内相对路径会解析错
                self.send_response(HTTPStatus.MOVED_PERMANENTLY)
                new_parts = (parts[0], parts[1], parts[2] + "/", parts[3], parts[4])
                self.send_header("Location", urlunsplit(new_parts))
                self.end_headers()
                return None
            for index in ("index.html", "index.htm"):
                index_path = os.path.join(path, index)
                if os.path.isfile(index_path):
                    path = index_path
                    break
            else:
                return self.list_directory(path)

        if path.endswith("/"):
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None

        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None

        try:
            st = os.fstat(f.fileno())
            file_size = st.st_size
            ctype = self.guess_type(path)
            etag = self._make_etag(st)
            last_modified = self.date_time_string(int(st.st_mtime))

            # ---- 1) 条件请求：回 304，让浏览器直接用缓存（循环播放不再重传）----
            if self._is_not_modified(etag, st):
                f.close()
                self.send_response(HTTPStatus.NOT_MODIFIED)
                self.send_header("ETag", etag)
                self.send_header("Last-Modified", last_modified)
                self.end_headers()
                return None

            # ---- 2) Range 请求（seek / 断点续传），受 If-Range 约束 ----
            rng = self._parse_range(file_size) if self._range_valid(etag, st) else None

            if rng == "unsatisfiable":
                f.close()
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("ETag", etag)
                self.send_header("Content-Range", "bytes */%d" % file_size)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return None

            if rng is not None:
                start, end = rng
                length = end - start + 1
                f.seek(start)
                self.send_response(HTTPStatus.PARTIAL_CONTENT)
                self.send_header("Content-Type", ctype)
                self.send_header("ETag", etag)
                self.send_header("Last-Modified", last_modified)
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, file_size))
                self.send_header("Content-Length", str(length))
                self.end_headers()
                return _RangeReader(f, length)

            # ---- 3) 普通 200 全量 ----
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", ctype)
            self.send_header("ETag", etag)
            self.send_header("Last-Modified", last_modified)
            self.send_header("Content-Length", str(file_size))
            self.end_headers()
            return f
        except Exception:
            f.close()
            raise


class NCEServer(ThreadingHTTPServer):
    """关闭 allow_reuse_address 的 ThreadingHTTPServer。

    http.server 默认 allow_reuse_address=1（为的是重启时避开 TIME_WAIT），
    但在 Windows 上该选项的语义不同：它允许多个进程绑定同一个端口且bind 成功，
    结果是两个服务器同时"监听"同一端口，请求被随机分发，
    端口占用检测也就永远不会触发。这里关掉它，让"端口真的被占用"时
    bind 直接失败，从而正确走到下面的自动顺延逻辑。
    """

    allow_reuse_address = False
    daemon_threads = True


def port_in_use(port, host="127.0.0.1", timeout=0.35):
    """先探一次：能不能连上该端口。能连上说明已有服务在跑（含上一次没退出的）。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        return sock.connect_ex((host, port)) == 0


def bind_server(port, handler, max_tries=20):
    """从 port 起依次尝试绑定，端口被占用时自动顺延，返回 (server, 实际端口)。"""
    last_err = None
    for candidate in range(port, port + max_tries):
        if port_in_use(candidate):
            last_err = "端口 %d 已有服务在监听" % candidate
            continue
        try:
            # HTTPServer 在构造时就会 bind，端口占用会抛 OSError
            server = NCEServer((BIND_HOST, candidate), handler)
            return server, candidate
        except OSError as exc:
            last_err = exc
    raise SystemExit(
        "无法绑定端口 %d~%d（均被占用或无权限）。\n最后一个错误：%s"
        % (port, port + max_tries - 1, last_err)
    )


def open_browser_later(url, delay=0.6):
    """等服务器真正 listen 之后再开浏览器，避免出现“无法访问”的空白页。"""
    def _open():
        try:
            webbrowser.open(url)
        except Exception as exc:  # 打不开也不影响服务本身
            sys.stderr.write("[nce] 打开浏览器失败：%s\n" % exc)

    threading.Timer(delay, _open).start()


def configure_console():
    """保证中文提示在任何语言的 Windows 上都能正常显示，且不会因为编码直接崩溃。

    Python 往控制台输出时用的是系统区域编码（中文 Windows 是 GBK，
    英文 Windows 可能是 cp1252 / cp437）。直接 print 中文在非中文系统上会抛
    UnicodeEncodeError，导致程序一启动就崩——而本程序正是要分发给
    "没有 Python 的电脑"使用，必须避免这种环境差异。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    if os.name == "nt":
        try:
            import ctypes

            # 65001 = UTF-8 代码页，让控制台能正确显示中文
            ctypes.windll.kernel32.SetConsoleOutputCP(65001)
            ctypes.windll.kernel32.SetConsoleCP(65001)
        except Exception:
            pass


def main():
    configure_console()

    parser = argparse.ArgumentParser(
        description="NCE 新概念英语点读系统 - 本地服务器（支持 Range / 304）"
    )
    parser.add_argument("port", nargs="?", type=int, default=PORT,
                        help="监听端口，默认 %d" % PORT)
    parser.add_argument("--no-browser", action="store_true",
                        help="启动后不自动打开浏览器")
    args = parser.parse_args()

    handler = partial(NoCacheHandler, directory=ROOT)
    server, port = bind_server(args.port, handler)
    server.daemon_threads = True

    url = "http://%s:%d/" % (BIND_HOST, port)
    print("=" * 58)
    print("  NCE 新概念英语点读系统 - 本地服务已启动")
    print("")
    print("  访问地址 : %s" % url)
    print("  服务目录 : %s" % ROOT)
    print("  能力     : Range 断点续传 / 304 缓存协商：已开启")
    if port != args.port:
        print("  注意     : 端口 %d 被占用，已自动改用 %d" % (args.port, port))
    if not os.path.isfile(os.path.join(ROOT, "index.html")):
        # 双击 exe 时目录以 exe 所在位置为准，放错位置会给个明确提示，
        # 而不是让人对着一个目录列表发懵
        print("  警告     : 该目录下没有 index.html，页面可能打不开。")
        print("             请把本程序放在项目根目录（与 index.html 同级）后重新运行。")
    print("")
    print("  停止服务 : 直接关闭本窗口，或按 Ctrl+C")
    print("=" * 58)
    sys.stdout.flush()

    if not args.no_browser:
        open_browser_later(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[nce] 已停止服务。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()