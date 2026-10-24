/**
 * 课本目录与课件配置加载
 * @module services/BookService
 */

import { CONFIG } from '../config.js';

/**
 * 重复 key 的书本用哪个后缀：优先取来源里能表意的一段
 * （镜像站取域名，本地目录取末级目录名），取不出来再用短哈希兜底。
 * 这样 id 与 data.json 的排列顺序无关，重排/增删其它条目都不会变。
 * @param {Object} book
 * @param {string} base 书本 key
 */
function idSuffix(book, base) {
  const raw = String(book.path ?? book.bookPath ?? '').trim();
  const host = raw.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i);
  if (host) return host[1].replace(/^www\./i, '');
  const last = raw.split(/[\\/]/).filter(Boolean).pop() || '';
  const slug = last.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug && slug.toLowerCase() !== base.toLowerCase()) return slug;
  return shortHash(raw || base);
}

/** FNV-1a 短哈希，仅在来源本身表意不足时兜底 */
function shortHash(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** 已是绝对地址（http(s):// 或 / 开头）时不再拼 bookPath */
function isAbsoluteUrl(path) {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(path) || String(path).startsWith('/');
}

export class BookService {
  /**
   * @param {string} [catalogUrl='data.json']
   */
  constructor(catalogUrl = 'data.json') {
    this.catalogUrl = catalogUrl;
    this.books = [];
  }

  /**
   * @param {AbortSignal} [signal]
   * @returns {Promise<Array>}
   */
  async loadCatalog(signal) {
    const response = await fetch(this.catalogUrl, { signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    this.books = Array.isArray(data.books) ? data.books : [];
    this.#assignIds();
    return this.books;
  }

  /**
   * 给每本书补一个唯一 id
   *
   * data.json 允许同一 key 配多个来源（例如 NCE1 同时有本地 resources 和几个镜像站），
   * 只用 key 当标识时「选中第二个却解析到第一个」，所以选择/记住的书本统一用 id。
   * 首次出现的 key 直接沿用 key 本身，保证旧的 hash 链接与学习进度不失效；
   * 重复项追加「路径短哈希」后缀（同一个来源无论排第几、怎么重排，id 都不变）。
   */
  #assignIds() {
    const used = new Set();
    for (const book of this.books) {
      if (!book || typeof book !== 'object') continue;
      const base = String(book.key ?? '').trim() || 'book';
      if (book.id) {
        used.add(String(book.id));
        continue;
      }
      let id = base;
      if (used.has(id)) {
        const suffix = idSuffix(book, base);
        id = `${base}-${suffix}`;
        let counter = 2;
        while (used.has(id)) {
          id = `${base}-${suffix}-${counter}`;
          counter += 1;
        }
      }
      book.id = id;
      used.add(id);
    }
  }

  /**
   * @param {string} bookId 首选唯一 id；也接受旧的 key（兼容旧链接 / 旧 localStorage）
   * @param {string} defaultKey
   * @returns {Object|null}
   */
  resolve(bookId, defaultKey) {
    if (!this.books.length) return null;

    const isUsable = (book) => Boolean(book?.path || book?.bookPath || book?.custom);

    const byId = this.books.find((book) => book?.id === bookId && isUsable(book));
    if (byId) return byId;

    // key 可能对应多本书，这里取第一本；旧版本存的就是 key，行为与升级前一致
    const exact = this.books.find((book) => book?.key === bookId && isUsable(book));
    if (exact) return exact;

    const fallback = this.books.find((book) => book?.key === defaultKey && isUsable(book));
    if (fallback) return fallback;

    return this.books.find(isUsable) || null;
  }

  /**
   * @param {{key?: string, path?: string, bookPath?: string}} book
   * @param {AbortSignal} [signal]
   * @returns {Promise<{units: Array, coverUrl: string, bookName: string, bookLevel: string}>}
   */
  async loadBook(book, signal) {
    const rawPath = book.path || '';
    const bookPath = rawPath.trim().replace(/\/$/, '');
    const response = await fetch(`${bookPath}/book.json`, { signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    const rawUnits = (Array.isArray(data.units) ? data.units : []).filter((unit) => unit?.filename);

    // book.json 只记不带扩展名的文件名，实际可能是 mp3/m4a/wav/flac 与 lrc/srt/vtt 的任意组合，
    // 这里用第一课探测一次、整本复用，避免每课都发一轮请求
    const exts = await this.#detectExtensions(bookPath, rawUnits[0], signal);

    const units = rawUnits.map((unit, index) => {
      const audioFile = unit.audio || `${unit.filename}.${exts.audio}`;
      const subtitleFile = unit.lrc || unit.subtitle || `${unit.filename}.${exts.subtitle}`;
      return {
        ...unit,
        id: index + 1,
        title: unit.title || `Unit ${index + 1}`,
        audio: isAbsoluteUrl(audioFile) ? audioFile : `${bookPath}/${audioFile}`,
        lrc: isAbsoluteUrl(subtitleFile) ? subtitleFile : `${bookPath}/${subtitleFile}`,
        subtitleExt: exts.subtitle,
      };
    });

    return {
      units,
      coverUrl: data.cover ? `${bookPath}/${data.cover}` : '',
      bookName: data.name || book.title || '',
      bookLevel: data.level || book.key || '',
    };
  }

  /**
   * 探测课本实际使用的音频 / 字幕扩展名
   *
   * 拿第一课按优先级（mp3 > m4a > wav > flac、lrc > srt > vtt）试，
   * 取第一个真实存在的文件。探测不到时（例如服务器不支持 HEAD）退回 mp3 / lrc，
   * 与加格式支持之前的行为完全一致。
   * @param {string} bookPath
   * @param {{filename?: string}} [sampleUnit] 用于探测的样本课（取第一课）
   * @param {AbortSignal} [signal]
   * @returns {Promise<{audio: string, subtitle: string}>}
   */
  async #detectExtensions(bookPath, sampleUnit, signal) {
    const fallbackAudio = CONFIG.MEDIA.AUDIO_EXTS[0];
    const fallbackSubtitle = CONFIG.MEDIA.SUBTITLE_EXTS[0];
    const base = String(sampleUnit?.filename ?? '').trim();
    if (!base) return { audio: fallbackAudio, subtitle: fallbackSubtitle };

    const [audio, subtitle] = await Promise.all([
      this.#probeExtension(bookPath, base, CONFIG.MEDIA.AUDIO_EXTS, signal),
      this.#probeExtension(bookPath, base, CONFIG.MEDIA.SUBTITLE_EXTS, signal),
    ]);

    return { audio: audio || fallbackAudio, subtitle: subtitle || fallbackSubtitle };
  }

  /**
   * 并发探测，返回 exts 中优先级最高的那个存在项
   * @returns {Promise<string|null>}
   */
  async #probeExtension(bookPath, base, exts, signal) {
    const results = await Promise.all(exts.map(async (ext) => {
      try {
        const res = await fetch(`${bookPath}/${base}.${ext}`, { method: 'HEAD', signal });
        return res.ok ? ext : null;
      } catch {
        return null; // 404 / 不支持 HEAD / CORS 失败都当作不存在
      }
    }));
    // results 与 exts 同序，取第一个命中的即为优先级最高的
    return results.find(Boolean) || null;
  }
}
