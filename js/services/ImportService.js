/**
 * 自定义课本导入服务：文件夹 / 多选文件 / ZIP / URL 四种方式导入音频 + 字幕
 * 音频支持 mp3 / m4a / wav / flac，字幕支持 lrc / srt / vtt（同一课内可混用）
 * 导入结果持久化到 IndexedDB（音频存 Blob，字幕存文本），刷新后自动恢复
 * @module services/ImportService
 */

import { readZip } from './ZipReader.js';
import { CONFIG } from '../config.js';

const { AUDIO_EXTS, SUBTITLE_EXTS, AUDIO_MIME, SUBTITLE_MIME } = CONFIG.MEDIA;
const AUDIO_EXT_SET = new Set(AUDIO_EXTS);
const SUBTITLE_EXT_SET = new Set(SUBTITLE_EXTS);

/** 是否支持的音频扩展名 */
function isAudioExt(ext) {
  return AUDIO_EXT_SET.has(String(ext).toLowerCase());
}

/** 是否支持的字幕扩展名 */
function isSubtitleExt(ext) {
  return SUBTITLE_EXT_SET.has(String(ext).toLowerCase());
}

/** 音频扩展名 -> MIME，未知格式兜底 audio/mpeg（浏览器也支持按内容嗅探） */
function audioMime(ext) {
  return AUDIO_MIME[String(ext).toLowerCase()] || 'audio/mpeg';
}

/** 字幕扩展名 -> MIME */
function subtitleMime(ext) {
  return SUBTITLE_MIME[String(ext).toLowerCase()] || 'text/plain';
}

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
        result.push({ id: record.key, key: record.key, title: record.title, custom: true });
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
      const resolved = { id: 0, title: unit.title, audio: '', lrc: '', subtitleExt: unit.subtitleExt || '' };
      if (unit.fileKey) {
        const blob = await this.#request(FILES_STORE, 'readonly', (os) => os.get(unit.fileKey));
        if (!blob) continue; // 数据被清空，跳过该课
        resolved.audio = this.#createBlobUrl(blob);
      } else if (unit.audioUrl) {
        resolved.audio = unit.audioUrl;
      }
      if (unit.lrcText) {
        resolved.lrc = this.#createBlobUrl(
          new Blob([unit.lrcText], { type: subtitleMime(unit.subtitleExt) }),
        );
      } else if (unit.lrcUrl) {
        // 远程歌词（book.json 导入）：保留 URL，播放时按需加载，不预下载
        resolved.lrc = unit.lrcUrl;
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
    const files = Array.from(fileList || [])
      .filter((f) => f && (isAudioExt(extOf(f.name)) || isSubtitleExt(extOf(f.name))));
    if (!files.length) throw new Error(`未找到音频（${AUDIO_EXTS.join('/')}）或字幕（${SUBTITLE_EXTS.join('/')}）文件`);

    const record = this.#createRecord(options);
    const pairs = this.#pairFiles(files);

    // 默认书名：文件夹导入取根目录名
    if (!record.title && files[0]?.webkitRelativePath) {
      record.title = files[0].webkitRelativePath.split('/')[0] || options.title || this.#defaultTitle();
    }

    let done = 0;
    for (const pair of pairs) {
      const unit = {
        title: pair.title,
        filename: pair.base,
        fileKey: null,
        lrcText: null,
        audioExt: pair.audioExt || '',
        subtitleExt: pair.subtitleExt || '',
      };
      if (pair.audio) {
        const ext = pair.audioExt || extOf(pair.audio.name);
        unit.fileKey = `${record.key}/${pair.base}.${ext}`;
        await this.#request(FILES_STORE, 'readwrite', (os) => os.put(this.#toAudioBlob(pair.audio, ext), unit.fileKey));
      }
      if (pair.subtitle) {
        unit.lrcText = await pair.subtitle.text();
      }
      record.units.push(unit);
      done += 1;
      onProgress?.(done, pairs.length);
    }

    return this.#finalize(record);
  }

  /**
   * 音频文件 -> Blob，并确保 MIME 正确
   *
   * Windows 上浏览器给的 File.type 常常是空字符串（m4a / flac 尤其常见），
   * 存进 IndexedDB 再取出来播放时可能解不了码，所以按扩展名补一个。
   * @param {File|Blob} file
   * @param {string} ext
   * @returns {Blob}
   */
  #toAudioBlob(file, ext) {
    const declared = file.type || '';
    if (declared.startsWith('audio/')) return file;
    // Blob 可以直接接受 Blob/File 作为 part，不需要先读进内存
    return new Blob([file], { type: audioMime(ext) });
  }

  /**
   * 由 ZIP 二进制导入
   * @param {ArrayBuffer} buffer
   * @param {{title?: string}} [options]
   * @param {(done: number, total: number) => void} [onProgress]
   */
  async importFromZip(buffer, options = {}, onProgress) {
    const entries = await readZip(buffer);
    const media = entries.filter((e) => isAudioExt(extOf(e.name)) || isSubtitleExt(extOf(e.name)));
    if (!media.length) {
      throw new Error(`ZIP 内未找到音频（${AUDIO_EXTS.join('/')}）或字幕（${SUBTITLE_EXTS.join('/')}）文件`);
    }

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
        audio: isAudioExt(ext) ? e : null,
        subtitle: isSubtitleExt(ext) ? e : null,
        bytes: e.bytes,
      };
    });

    const pairs = this.#pairPseudo(pseudoFiles);
    let done = 0;
    for (const pair of pairs) {
      const unit = {
        title: pair.title,
        filename: pair.base,
        fileKey: null,
        lrcText: null,
        audioExt: pair.audioExt || '',
        subtitleExt: pair.subtitleExt || '',
      };
      if (pair.audio) {
        const ext = pair.audioExt || extOf(pair.audio.name);
        unit.fileKey = `${record.key}/${pair.base}.${ext}`;
        const blob = new Blob([pair.audio.bytes], { type: audioMime(ext) });
        await this.#request(FILES_STORE, 'readwrite', (os) => os.put(blob, unit.fileKey));
      }
      if (pair.subtitle) {
        unit.lrcText = new TextDecoder('utf-8').decode(pair.subtitle.bytes);
      }
      record.units.push(unit);
      done += 1;
      onProgress?.(done, pairs.length);
    }

    return this.#finalize(record);
  }

  /**
   * 由 URL 导入：自动识别 book.json 课程清单 / ZIP 包 / HTML 目录列表
   * @param {string} rawUrl
   * @param {{title?: string}} [options]
   * @param {(done: number, total: number) => void} [onProgress]
   */
  async importFromUrl(rawUrl, options = {}, onProgress) {
    const requestUrl = new URL(rawUrl, location.href).toString();

    // 目录形式的 URL（如 https://nce.mleo.site/NCE1）：优先探测其下的 book.json
    if (!/\.(json|zip)(\?|$)/i.test(requestUrl)) {
      const probeUrl = requestUrl.replace(/\/+$/, '') + '/book.json';
      try {
        const probe = await fetch(probeUrl);
        if (probe.ok) {
          const probeText = await probe.text();
          if (probeText.trim().startsWith('{')) {
            const data = JSON.parse(probeText);
            return this.#importFromBookJson(data, probe.url || probeUrl, options, onProgress);
          }
        }
      } catch {
        // 探测失败则回退到 ZIP / 目录列表逻辑
      }
    }

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

    // book.json 课程清单（或任意 JSON 清单）
    const text = new TextDecoder('utf-8').decode(buffer);
    const trimmed = text.trim();
    const isJson = /json/.test(contentType) || /\.json(\?|$)/i.test(url) || trimmed.startsWith('{');
    if (isJson) {
      let data;
      try {
        data = JSON.parse(trimmed);
      } catch {
        throw new Error('JSON 解析失败，请确认是有效的 book.json');
      }
      return this.#importFromBookJson(data, url, options, onProgress);
    }

    // HTML 目录列表：解析 <a href> 中的音频 / 字幕链接
    const mediaPattern = new RegExp(`\\.(${AUDIO_EXTS.join('|')}|${SUBTITLE_EXTS.join('|')})(\\?|$)`, 'i');
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const links = [...doc.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href'))
      .filter((href) => href && mediaPattern.test(href))
      .map((href) => new URL(href, url).toString());

    const audioPattern = new RegExp(`\\.(${AUDIO_EXTS.join('|')})(\\?|$)`, 'i');
    const subtitlePattern = new RegExp(`\\.(${SUBTITLE_EXTS.join('|')})(\\?|$)`, 'i');
    const audios = links.filter((l) => audioPattern.test(l));
    const subtitles = links.filter((l) => subtitlePattern.test(l));
    if (!audios.length) {
      throw new Error(`该 URL 不是 ZIP，目录列表中也未找到音频文件（${AUDIO_EXTS.join('/')}）`);
    }

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

    const subtitleMap = new Map();
    for (const subtitleUrl of subtitles) {
      subtitleMap.set(decodeBaseName(subtitleUrl).toLowerCase(), subtitleUrl);
    }

    const units = [];
    audios.sort(naturalCompare);
    for (const audioUrl of audios) {
      const base = decodeBaseName(audioUrl);
      const subtitleUrl = subtitleMap.get(base.toLowerCase()) || null;
      units.push({
        title: titleFromBase(base),
        filename: base,
        audioUrl,
        lrcUrl: subtitleUrl,
        subtitleExt: subtitleUrl ? extOf(new URL(subtitleUrl).pathname) : '',
      });
    }

    // 拉取字幕文本（小文件，直接存文本，播放时不再请求）
    let done = 0;
    for (const unit of units) {
      if (unit.lrcUrl) {
        try {
          const subRes = await fetch(unit.lrcUrl);
          if (subRes.ok) unit.lrcText = await subRes.text();
        } catch {
          // 单课字幕失败不阻断导入
        }
      }
      delete unit.lrcUrl;
      record.units.push(unit);
      done += 1;
      onProgress?.(done, units.length);
    }

    return this.#finalize(record);
  }

  /**
   * 由 book.json 课程清单导入（远程课本，音频/歌词保留原始 URL 按需加载）
   * @param {Object} data 已解析的 book.json
   * @param {string} baseUrl book.json 的最终 URL，用于解析相对路径
   * @param {{title?: string}} [options]
   * @param {(done: number, total: number) => void} [onProgress]
   */
  async #importFromBookJson(data, baseUrl, options = {}, onProgress) {
    const rawUnits = Array.isArray(data?.units) ? data.units : [];
    if (!rawUnits.length) throw new Error('book.json 中没有课程（units 为空）');

    const record = this.#createRecord({ ...options, source: 'url-json' });
    if (!record.title) record.title = this.#bookJsonTitle(data, baseUrl);

    const toUrl = (filePath) => {
      if (!filePath) return '';
      try {
        return new URL(filePath, baseUrl).toString();
      } catch {
        return '';
      }
    };

    let done = 0;
    for (const unit of rawUnits) {
      const filename = String(unit?.filename ?? unit?.name ?? '').trim();
      if (!filename) continue;
      // filename 可能自带扩展名（mp3/m4a/wav/flac 与 lrc/srt/vtt 都有可能）
      const base = filename.replace(
        new RegExp(`\\.(${AUDIO_EXTS.join('|')}|${SUBTITLE_EXTS.join('|')})$`, 'i'),
        '',
      );
      const audioUrl = toUrl(unit.audio || `${base}.${AUDIO_EXTS[0]}`);
      if (!audioUrl) continue;
      const subtitleFile = unit.lrc || unit.subtitle || `${base}.${SUBTITLE_EXTS[0]}`;
      record.units.push({
        title: unit.title || titleFromBase(base),
        filename: base,
        fileKey: null,
        lrcText: null,
        audioUrl,
        lrcUrl: toUrl(subtitleFile),
        subtitleExt: extOf(subtitleFile),
      });
      done += 1;
      onProgress?.(done, rawUnits.length);
    }
    if (!record.units.length) throw new Error('book.json 中没有可用课程');

    if (data.cover) {
      const coverUrl = toUrl(data.cover);
      if (coverUrl) record.coverUrl = coverUrl;
    }

    return this.#finalize(record);
  }

  /** book.json 书名优先级：URL 目录名 > name + level > name */
  #bookJsonTitle(data, baseUrl) {
    const segs = new URL(baseUrl).pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1] || '';
    const dirName = /\.json$/i.test(last) ? (segs[segs.length - 2] || '') : last;
    const decoded = (() => {
      try {
        return decodeURIComponent(dirName);
      } catch {
        return dirName;
      }
    })();
    if (decoded) return decoded;
    return [data?.name, data?.level].filter(Boolean).join(' ') || this.#defaultTitle('URL 导入');
  }

  /** File 对象配对（按不含扩展名的基础名，忽略大小写） */
  #pairFiles(files) {
    const pseudo = files.map((f) => {
      const ext = extOf(f.name);
      return {
        name: f.name,
        base: stripExt(f.name),
        ext,
        audio: isAudioExt(ext) ? f : null,
        subtitle: isSubtitleExt(ext) ? f : null,
        bytes: null,
      };
    });
    return this.#pairPseudo(pseudo);
  }

  #pairPseudo(items) {
    const byBase = new Map();
    for (const item of items) {
      const key = item.base.toLowerCase();
      if (!byBase.has(key)) {
        byBase.set(key, { base: item.base, audio: null, subtitle: null, audioExt: '', subtitleExt: '' });
      }
      const pair = byBase.get(key);
      if (item.audio) {
        pair.audio = item.audio;
        pair.audioExt = item.ext;
      }
      if (item.subtitle) {
        pair.subtitle = item.subtitle;
        pair.subtitleExt = item.ext;
      }
    }

    const pairs = [...byBase.values()]
      .filter((p) => p.audio) // 有音频才成课
      .sort((a, b) => naturalCompare(a.base, b.base))
      .map((p) => ({ ...p, title: titleFromBase(p.base) }));
    if (!pairs.length) throw new Error(`未配对到任何音频文件（${AUDIO_EXTS.join('/')}）`);
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
      coverUrl: record.coverUrl || '',
      bookName: record.title,
      bookLevel: record.source === 'url-json' ? '远程课本' : '导入课本',
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
      id: r.key,
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
