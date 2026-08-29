/**
 * 自定义课本导入服务：文件夹 / 多选文件 / ZIP / URL 四种方式导入 mp3+lrc
 * 导入结果持久化到 IndexedDB（音频存 Blob，歌词存文本），刷新后自动恢复
 * @module services/ImportService
 */

import { readZip } from './ZipReader.js';

const DB_NAME = 'nce-imports';
const DB_VERSION = 1;
const BOOKS_STORE = 'books';
const FILES_STORE = 'files';

/** 生成自定义书本 key */
function createBookKey() {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 从文件名/路径提取扩展名（小写） */
function extOf(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** 取路径的 basename */
function baseName(path) {
  const clean = String(path).replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

/** 去掉扩展名的文件名 */
function stripExt(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** URL 解码后的 basename（去扩展名），用于标题与配对键 */
function decodeBaseName(linkUrl) {
  const raw = stripExt(baseName(new URL(linkUrl).pathname));
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 由文件名推断课程标题：去掉「001&002－」这类编号前缀 */
function titleFromBase(base) {
  const matched = base.match(/^\d+(?:&\d+)*\s*[－—\-]\s*(.+)$/);
  if (matched && matched[1].trim()) return matched[1].trim();
  return base.trim();
}

/** 自然排序（数字感知），用于课程排序 */
function naturalCompare(a, b) {
  return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
}

export class ImportService {
  constructor() {
    this.dbPromise = null;
    /** @type {Map<string, Object>} bookKey -> 书本记录（含 blob URL 缓存） */
    this.records = new Map();
    this.blobUrls = [];
  }

  /** 打开（或复用）IndexedDB 连接 */
  #db() {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(BOOKS_STORE)) db.createObjectStore(BOOKS_STORE, { keyPath: 'key' });
          if (!db.objectStoreNames.contains(FILES_STORE)) db.createObjectStore(FILES_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return this.dbPromise;
  }

  #tx(store, mode) {
    return this.#db().then((db) => db.transaction(store, mode).objectStore(store));
  }

  #request(store, mode, action) {
    return this.#tx(store, mode).then((os) => new Promise((resolve, reject) => {
      const request = action(os);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  }

  /**
   * 启动时恢复所有自定义书本（并重建 blob URL）
   * @returns {Promise<Array<{key: string, title: string, custom: true}>>}
   */
  async restoreAll() {
    const raw = await this.#request(BOOKS_STORE, 'readonly', (os) => os.getAll());
    const books = Array.isArray(raw) ? raw : [];
    books.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    const result = [];
    for (const record of books) {
      try {
        await this.#materialize(record);
        this.records.set(record.key, record);
        result.push({ key: record.key, title: record.title, custom: true });
      } catch (error) {
        console.error(`[import] 恢复书本失败：${record.title}`, error);
      }
    }
    return result;
  }

  /** 为书本记录里的音频/歌词重建 blob URL，生成可播放的 units */
  async #materialize(record) {
    const units = [];
    for (const unit of record.units || []) {
      const resolved = { id: 0, title: unit.title, audio: '', lrc: '' };
      if (unit.fileKey) {
        const blob = await this.#request(FILES_STORE, 'readonly', (os) => os.get(unit.fileKey));
        if (!blob) continue; // 数据被清空，跳过该课
        resolved.audio = this.#createBlobUrl(blob);
      } else if (unit.audioUrl) {
        resolved.audio = unit.audioUrl;
      }
      if (unit.lrcText) {
        resolved.lrc = this.#createBlobUrl(new Blob([unit.lrcText], { type: 'text/plain' }));
      }
      if (!resolved.audio) continue;
      resolved.id = units.length + 1;
      units.push(resolved);
    }
    record.resolvedUnits = units;
    if (!units.length) throw new Error('没有可用课程');
  }

  #createBlobUrl(blob) {
    const url = URL.createObjectURL(blob);
    this.blobUrls.push(url);
    return url;
  }

  /**
   * 由 File 列表导入（文件夹批量 / 多选文件共用）
   * @param {FileList|File[]} fileList
   * @param {{title?: string, source?: string}} [options]
   * @param {(done: number, total: number) => void} [onProgress]
   * @returns {Promise<{key: string, title: string, custom: true, unitCount: number}>}
   */
  async importFromFileList(fileList, options = {}, onProgress) {
    const files = Array.from(fileList || []).filter((f) => f && /^(mp3|lrc)$/i.test(extOf(f.name)));
    if (!files.length) throw new Error('未找到 mp3 / lrc 文件');

    const record = this.#createRecord(options);
    const pairs = this.#pairFiles(files);

    // 默认书名：文件夹导入取根目录名
    if (!record.title && files[0]?.webkitRelativePath) {
      record.title = files[0].webkitRelativePath.split('/')[0] || options.title || this.#defaultTitle();
    }

    let done = 0;
    for (const pair of pairs) {
      const unit = { title: pair.title, filename: pair.base, fileKey: null, lrcText: null };
      if (pair.audio) {
        unit.fileKey = `${record.key}/${pair.base}.mp3`;
        await this.#request(FILES_STORE, 'readwrite', (os) => os.put(pair.audio, unit.fileKey));
      }
      if (pair.lrc) {
        unit.lrcText = await pair.lrc.text();
      }
      record.units.push(unit);
      done += 1;
      onProgress?.(done, pairs.length);
    }

    return this.#finalize(record);
  }

  /**
   * 由 ZIP 二进制导入
   * @param {ArrayBuffer} buffer
   * @param {{title?: string}} [options]
   * @param {(done: number, total: number) => void} [onProgress]
   */
  async importFromZip(buffer, options = {}, onProgress) {
    const entries = await readZip(buffer);
    const media = entries.filter((e) => /^(mp3|lrc)$/i.test(extOf(e.name)));
    if (!media.length) throw new Error('ZIP 内未找到 mp3 / lrc 文件');

    const record = this.#createRecord(options);
    // 默认书名优先级：用户输入 > 压缩包内唯一一级目录 > zip 文件名
    if (!record.title) {
      const roots = new Set(media.map((e) => (e.name.includes('/') ? e.name.split('/')[0] : '')));
      const innerRoot = roots.size === 1 && !roots.has('') ? [...roots][0] : '';
      record.title = innerRoot
        || (options.zipName ? options.zipName.replace(/\.zip$/i, '') : '')
        || this.#defaultTitle();
    }

    const pseudoFiles = media.map((e) => {
      const ext = extOf(e.name);
      return {
        name: baseName(e.name),
        base: stripExt(baseName(e.name)),
        ext,
        audio: ext === 'mp3' ? e : null,
        lrc: ext === 'lrc' ? e : null,
        bytes: e.bytes,
      };
    });

    const pairs = this.#pairPseudo(pseudoFiles);
    let done = 0;
    for (const pair of pairs) {
      const unit = { title: pair.title, filename: pair.base, fileKey: null, lrcText: null };
      if (pair.audio) {
        unit.fileKey = `${record.key}/${pair.base}.mp3`;
        const blob = new Blob([pair.audio.bytes], { type: 'audio/mpeg' });
        await this.#request(FILES_STORE, 'readwrite', (os) => os.put(blob, unit.fileKey));
      }
      if (pair.lrc) {
        unit.lrcText = new TextDecoder('utf-8').decode(pair.lrc.bytes);
      }
      record.units.push(unit);
      done += 1;
      onProgress?.(done, pairs.length);
    }

    return this.#finalize(record);
  }

  /**
   * 由 URL 导入：自动识别 ZIP 包或 HTML 目录列表
   * @param {string} rawUrl
   * @param {{title?: string}} [options]
   * @param {(done: number, total: number) => void} [onProgress]
   */
  async importFromUrl(rawUrl, options = {}, onProgress) {
    const requestUrl = new URL(rawUrl, location.href).toString();
    const response = await fetch(requestUrl);
    if (!response.ok) throw new Error(`URL 请求失败：HTTP ${response.status}`);

    // 以最终 URL（含 301 重定向后的尾斜杠）为基准解析相对链接
    const url = response.url || requestUrl;

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const buffer = await response.arrayBuffer();
    const isZip = /zip/.test(contentType)
      || /\.zip(\?|$)/i.test(url)
      || (buffer.byteLength >= 4
        && buffer[0] === 0x50 && buffer[1] === 0x4b
        && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07));

    if (isZip) {
      const fallbackTitle = options.title || stripExt(baseName(new URL(url).pathname)) || 'URL 导入';
      return this.importFromZip(buffer, { ...options, title: fallbackTitle }, onProgress);
    }

    // HTML 目录列表：解析 <a href> 中的 mp3 / lrc
    const html = new TextDecoder('utf-8').decode(buffer);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const links = [...doc.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href'))
      .filter((href) => href && /\.(mp3|lrc)(\?|$)/i.test(href))
      .map((href) => new URL(href, url).toString());

    const mp3s = links.filter((l) => /\.mp3(\?|$)/i.test(l));
    const lrcs = links.filter((l) => /\.lrc(\?|$)/i.test(l));
    if (!mp3s.length) throw new Error('该 URL 不是 ZIP，目录列表中也未找到 mp3 文件');

    const record = this.#createRecord(options);
    if (!record.title) {
      const pathSegs = new URL(url).pathname.split('/').filter(Boolean);
      let lastSeg = pathSegs[pathSegs.length - 1] || options.title || this.#defaultTitle('URL 导入');
      try {
        lastSeg = decodeURIComponent(lastSeg);
      } catch {
        // 保留原样
      }
      record.title = lastSeg;
    }

    const lrcMap = new Map();
    for (const lrcUrl of lrcs) {
      lrcMap.set(decodeBaseName(lrcUrl).toLowerCase(), lrcUrl);
    }

    const units = [];
    mp3s.sort(naturalCompare);
    for (const mp3Url of mp3s) {
      const base = decodeBaseName(mp3Url);
      const lrcUrl = lrcMap.get(base.toLowerCase()) || null;
      units.push({ title: titleFromBase(base), filename: base, audioUrl: mp3Url, lrcUrl });
    }

    // 拉取歌词文本（小文件，直接存文本，播放时不再请求）
    let done = 0;
    for (const unit of units) {
      if (unit.lrcUrl) {
        try {
          const lrcRes = await fetch(unit.lrcUrl);
          if (lrcRes.ok) unit.lrcText = await lrcRes.text();
        } catch {
          // 单课歌词失败不阻断导入
        }
      }
      delete unit.lrcUrl;
      record.units.push(unit);
      done += 1;
      onProgress?.(done, units.length);
    }

    return this.#finalize(record);
  }

  /** File 对象配对（按不含扩展名的基础名，忽略大小写） */
  #pairFiles(files) {
    const pseudo = files.map((f) => ({
      name: f.name,
      base: stripExt(f.name),
      ext: extOf(f.name),
      audio: f.name.toLowerCase().endsWith('.mp3') ? f : null,
      lrc: f.name.toLowerCase().endsWith('.lrc') ? f : null,
      bytes: null,
    }));
    return this.#pairPseudo(pseudo);
  }

  #pairPseudo(items) {
    const byBase = new Map();
    for (const item of items) {
      const key = item.base.toLowerCase();
      if (!byBase.has(key)) byBase.set(key, { base: item.base, audio: null, lrc: null });
      const pair = byBase.get(key);
      if (item.audio) pair.audio = item.audio;
      if (item.lrc) pair.lrc = item.lrc;
    }

    const pairs = [...byBase.values()]
      .filter((p) => p.audio) // 有音频才成课
      .sort((a, b) => naturalCompare(a.base, b.base))
      .map((p) => ({ ...p, title: titleFromBase(p.base) }));
    if (!pairs.length) throw new Error('未配对到任何 mp3（缺少音频文件）');
    return pairs;
  }

  #createRecord(options) {
    return {
      key: createBookKey(),
      title: (options.title || '').trim(),
      source: options.source || 'files',
      createdAt: Date.now(),
      units: [],
    };
  }

  /** 兜底书名：带上日期，避免多次导入都叫「导入课本」难以区分 */
  #defaultTitle(prefix = '导入课本') {
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${prefix} ${mm}-${dd}`;
  }

  /** 落库并进入内存缓存 */
  async #finalize(record) {
    if (!record.title) record.title = this.#defaultTitle();
    await this.#materialize(record);
    await this.#request(BOOKS_STORE, 'readwrite', (os) => os.put(record));
    this.records.set(record.key, record);
    return { key: record.key, title: record.title, custom: true, unitCount: record.units.length };
  }

  /**
   * 为 BookService.loadBook 提供同构数据
   * @param {{key: string}} book
   * @returns {Promise<{units: Array, coverUrl: string, bookName: string, bookLevel: string}>}
   */
  async loadBook(book) {
    const record = this.records.get(book.key);
    if (!record) throw new Error('自定义课本不存在或已删除');
    return {
      units: (record.resolvedUnits || []).map((unit, index) => ({
        ...unit,
        id: index + 1,
        title: unit.title || `Unit ${index + 1}`,
      })),
      coverUrl: '',
      bookName: record.title,
      bookLevel: '导入课本',
    };
  }

  /**
   * 删除自定义课本（含音频 Blob）
   * @param {string} bookKey
   */
  async deleteBook(bookKey) {
    const record = this.records.get(bookKey);
    if (record) {
      const keys = (record.units || []).map((u) => u.fileKey).filter(Boolean);
      for (const key of keys) {
        await this.#request(FILES_STORE, 'readwrite', (os) => os.delete(key)).catch(() => {});
      }
    }
    await this.#request(BOOKS_STORE, 'readwrite', (os) => os.delete(bookKey)).catch(() => {});
    this.records.delete(bookKey);
    return Boolean(record);
  }

  /** 当前所有自定义书本（用于面板管理列表） */
  listBooks() {
    return [...this.records.values()].map((r) => ({
      key: r.key,
      title: r.title,
      unitCount: (r.resolvedUnits || r.units || []).length,
      source: r.source,
    }));
  }

  /** 释放全部 blob URL（页面卸载时调用） */
  revokeBlobUrls() {
    this.blobUrls.forEach((url) => URL.revokeObjectURL(url));
    this.blobUrls = [];
  }
}
