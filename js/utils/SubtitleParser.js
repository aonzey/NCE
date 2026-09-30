/**
 * 字幕解析统一入口：LRC / SRT / VTT
 *
 * - LRC：`[mm:ss.xx]英文 | 中文`，只有起始时间，句子结束时间由下一句推得
 * - SRT / VTT：`序号` + `起 --> 止` + 多行文本，自带结束时间
 *
 * 三者统一输出 `{time, end, english, chinese, fullText}`，
 * 因此上层（高亮、单句循环、跟读间隔）无需关心来源格式。
 * @module utils/SubtitleParser
 */

import { LRCParser } from './LRCParser.js';

/** `00:00:01,500 --> 00:00:04,000`，VTT 允许在结束时间后追加 cue settings */
const CUE_TIMING_REGEX = /^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)(.*)$/;

/** 时间戳：`HH:MM:SS,mmm` / `MM:SS.mmm`，分隔符逗号或点均可 */
const TIMESTAMP_REGEX = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/;

/** 中日韩字符，用于判断字幕里哪一段是中文 */
const CJK_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/** 把 `00:01.500` / `01:00:01,500` 解析成秒 */
function parseTimestamp(token) {
  const matched = String(token).trim().match(TIMESTAMP_REGEX);
  if (!matched) return NaN;

  const hours = matched[1] ? Number(matched[1]) : 0;
  const minutes = Number(matched[2]);
  const seconds = Number(matched[3]);
  // 与 LRC 保持一致：把 1~3 位毫秒统一转秒（"4"->0.4s, "45"->0.45s, "456"->0.456s）
  const fraction = matched[4] ? Number(`0.${matched[4]}`) : 0;

  return hours * 3600 + minutes * 60 + seconds + fraction;
}

/**
 * 去掉字幕里的样式标记：VTT 的 `<v Speaker>` / `<i>`，SRT 的 `{\an8}` / `<i>`
 * @param {string} line
 * @returns {string}
 */
function stripMarkup(line) {
  return line
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<\/?[^>]+>/g, '')
    .trim();
}

export class SubtitleParser {
  /**
   * 解析字幕文本，自动识别格式
   * @param {string} text 字幕原文
   * @param {number} [timeOffset=0] 统一前移的时间（秒）
   * @param {string} [formatHint=''] 文件名/扩展名提示，给不出时靠内容识别
   * @returns {Array<{time: number, end?: number, english: string, chinese: string, fullText: string}>}
   */
  static parse(text, timeOffset = 0, formatHint = '') {
    if (!text || typeof text !== 'string') return [];

    const format = SubtitleParser.detectFormat(text, formatHint);
    if (format === 'srt' || format === 'vtt') {
      return SubtitleParser.#parseCues(text, timeOffset);
    }
    return LRCParser.parse(text, timeOffset);
  }

  /**
   * 识别字幕格式
   * @param {string} text
   * @param {string} [hint] 扩展名（可带点）
   * @returns {'lrc'|'srt'|'vtt'}
   */
  static detectFormat(text, hint = '') {
    const ext = String(hint || '').trim().toLowerCase().replace(/^\./, '');
    if (ext === 'lrc' || ext === 'srt' || ext === 'vtt') return ext;

    const head = String(text).slice(0, 4096);
    if (/^\uFEFF?\s*WEBVTT/.test(head)) return 'vtt';
    if (/\d\s*-->\s*\d/.test(head)) return 'srt'; // 缺 WEBVTT 头的 VTT 也走同一套块解析
    if (/\[\d{1,3}:\d{2}[.,]\d{1,3}\]/.test(head)) return 'lrc';
    return 'lrc';
  }

  /**
   * 解析块式字幕（SRT 与 VTT 共用）
   *
   * 形如：`序号`（可选）→ `起 --> 止` → 若干行文本 → 空行。
   * VTT 的 NOTE / STYLE / REGION 块因为没有 `-->` 行，会被当作序号丢弃。
   * @param {string} text
   * @param {number} timeOffset
   * @returns {Array}
   */
  static #parseCues(text, timeOffset) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const lyrics = [];

    let cue = null;
    const flush = () => {
      if (!cue) return;
      const entry = SubtitleParser.#buildEntry(cue, timeOffset);
      if (entry) lyrics.push(entry);
      cue = null;
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const timing = line.match(CUE_TIMING_REGEX);

      if (timing) {
        flush();
        const start = parseTimestamp(timing[1]);
        const end = parseTimestamp(timing[2]);
        if (!Number.isFinite(start)) continue;
        cue = { start, end, lines: [] };
        continue;
      }

      if (!line.trim()) {
        // 空行结束当前字幕块（SRT 的固定分隔）
        flush();
        continue;
      }

      if (cue) {
        // 缺空行的 SRT：当前行是纯数字序号、且下一行是时间行 -> 结束上一块
        const nextIsTiming = i + 1 < lines.length && CUE_TIMING_REGEX.test(lines[i + 1]);
        if (nextIsTiming && /^\d+$/.test(line.trim())) {
          flush();
          continue;
        }
        cue.lines.push(line);
      }
      // 不在块内：序号 / 文件头 / NOTE 块，直接忽略
    }
    flush();

    return lyrics.sort((a, b) => a.time - b.time);
  }

  /**
   * 把一块字幕整理成统一的歌词条目
   * @param {{start: number, end: number, lines: string[]}} cue
   * @param {number} timeOffset
   * @returns {Object|null}
   */
  static #buildEntry(cue, timeOffset) {
    const raw = cue.lines.map(stripMarkup).filter(Boolean);
    if (!raw.length) return null;

    const { english, chinese, fullText } = SubtitleParser.#splitBilingual(raw);
    if (!english) return null;

    const round = (value) => Math.round(value * 1000) / 1000;
    const time = round(cue.start - timeOffset);
    const end = Number.isFinite(cue.end) ? round(cue.end - timeOffset) : NaN;

    // 只有合理的结束时间才记录；否则交给 getSentenceBoundaries 用下一句推
    if (Number.isFinite(end) && end > time) {
      return { time, end, english, chinese, fullText };
    }
    return { time, english, chinese, fullText };
  }

  /**
   * 拆分中英双语
   *
   * 优先级：文本里的 `|` 分隔符（沿用 LRC 约定）> 「首个含中日韩字符的行」之前是英文、之后是中文
   * > 整块都是英文。这样既能处理双语字幕，也不会把换行的英文误判成中文。
   * @param {string[]} lines
   * @returns {{english: string, chinese: string, fullText: string}}
   */
  static #splitBilingual(lines) {
    const flat = lines.join(' ').trim();

    if (flat.includes('|')) {
      const [english = '', chinese = ''] = flat.split('|').map((part) => part.trim());
      return { english, chinese, fullText: flat };
    }

    const cjkIndex = lines.findIndex((line) => CJK_REGEX.test(line));
    if (cjkIndex > 0) {
      const english = lines.slice(0, cjkIndex).join(' ').trim();
      const chinese = lines.slice(cjkIndex).join(' ').trim();
      return { english, chinese, fullText: `${english} | ${chinese}` };
    }

    return { english: flat, chinese: '', fullText: flat };
  }

  /**
   * 播放时间对应的字幕下标
   * @param {Array<{time: number}>} lyrics
   * @param {number} currentTime
   * @returns {number}
   */
  static findLyricIndexByTime(lyrics, currentTime) {
    if (!Array.isArray(lyrics) || lyrics.length === 0) return -1;

    for (let i = lyrics.length - 1; i >= 0; i -= 1) {
      if (currentTime >= lyrics[i].time) return i;
    }
    return -1;
  }

  /**
   * 句子的起止时间
   * SRT/VTT 自带结束时间，优先用它；LRC 没有，退回「下一句的起始时间」
   * @param {Array<{time: number, end?: number}>} lyrics
   * @param {number} index
   * @param {number} [audioDuration=0]
   * @returns {{startTime: number, endTime: number, index: number}|null}
   */
  static getSentenceBoundaries(lyrics, index, audioDuration = 0) {
    if (!Array.isArray(lyrics) || index < 0 || index >= lyrics.length) return null;

    const startTime = lyrics[index].time;
    const declaredEnd = Number(lyrics[index].end);
    const nextStart = index < lyrics.length - 1 ? Number(lyrics[index + 1].time) : NaN;

    let endTime;
    if (Number.isFinite(declaredEnd) && declaredEnd > startTime) {
      endTime = declaredEnd;
    } else if (Number.isFinite(nextStart) && nextStart > startTime) {
      endTime = nextStart;
    } else {
      endTime = Math.max(audioDuration, startTime + 0.1);
    }

    return { startTime, endTime, index };
  }
}
