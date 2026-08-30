import os
import re
import sys
from email.utils import mktime_tz, parsedate_tz
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, urlunsplit

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

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


def main():
    handler = partial(NoCacheHandler, directory=".")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    server.daemon_threads = True
    print("NCE server listening on http://127.0.0.1:%d (Range + 304: supported)" % PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()