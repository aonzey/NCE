/**
 * 课本目录与课件配置加载
 * @module services/BookService
 */

import { CONFIG } from '../config.js';

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
    return this.books;
  }

  /**
   * @param {string} bookKey
   * @param {string} defaultKey
   * @returns {Object|null}
   */
  resolve(bookKey, defaultKey) {
    if (!this.books.length) return null;

    const isUsable = (book) => Boolean(book?.path || book?.bookPath || book?.custom);

    const exact = this.books.find((book) => book?.key === bookKey && isUsable(book));
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
