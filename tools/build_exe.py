#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 tools/server.py 打包成一个独立的 Windows 可执行程序（.exe）。

目的：让**没有安装 Python** 的电脑也能一键使用本项目。
使用者只需要拿到 NCE-Server.exe，把它放在项目根目录双击即可，
程序会自动启动本地服务并打开浏览器，关闭窗口即可停止。

只有需要**重新打包**的人才需要 Python 环境：
    pip install pyinstaller
    python tools/build_exe.py

产物：项目根目录下的 NCE-Server.exe
"""

import os
import shutil
import subprocess
import sys
import tempfile

EXE_NAME = "NCE-Server"


def project_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    root = project_root()
    entry = os.path.join(root, "tools", "server.py")
    icon = os.path.join(root, "favicon.ico")
    # 中间产物放到系统临时目录：既不污染仓库，
    # 也避免清理仓库内目录时受沙箱 / 回收站限制导致打包失败
    build_dir = tempfile.mkdtemp(prefix="nce_build_")

    if not os.path.isfile(entry):
        print("找不到入口文件：%s" % entry)
        return 1

    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print("当前 Python 环境未安装 PyInstaller，请先执行：")
        print("    %s -m pip install pyinstaller" % sys.executable)
        return 1

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--clean",       # 清掉 PyInstaller 缓存，避免旧依赖残留
        "--onefile",     # 单文件，方便分发给别人
        "--console",     # 保留控制台：能看到访问地址、可按 Ctrl+C 停止
        "--name", EXE_NAME,
        "--distpath", root,
        "--workpath", build_dir,
        "--specpath", build_dir,
    ]
    if os.path.isfile(icon):
        cmd += ["--icon", icon]
    cmd.append(entry)

    print("开始打包（需要几十秒，请稍候）...")
    print("  %s\n" % " ".join('"%s"' % c if " " in c else c for c in cmd))

    result = subprocess.call(cmd, cwd=root)
    if result != 0:
        print("\n打包失败，退出码 %d。" % result)
        return result

    exe_path = os.path.join(root, EXE_NAME + ".exe")
    if os.path.isfile(exe_path):
        size_mb = os.path.getsize(exe_path) / 1024.0 / 1024.0
        print("\n打包成功：%s（%.1f MB）" % (exe_path, size_mb))
        print("把它与项目文件放在同一目录，双击即可使用（无需 Python）。")
    else:
        print("\n打包结束，但没找到预期的 %s，请检查上方输出。" % exe_path)
        return 1

    # 清理临时中间产物（忽略错误：删不掉也只是留个临时目录，不影响产物）
    shutil.rmtree(build_dir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
