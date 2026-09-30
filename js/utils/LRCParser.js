/**
 * LRC 歌词解析：`[mm:ss.xx]英文 | 中文`
 *
 * 只负责 LRC 这一种格式。对外请用 {@link module:utils/SubtitleParser}，
 * 它会自动识别 LRC / SRT / VTT 并统一输出，句子边界等通用时间计算也在那里。
 * @module utils/LRCParser
 */

export class LRCParser {
  /**
   * @param {string} lrcText
   * @param {number} [timeOffset=0]
   * @returns {Array<{time: number, english: string, chinese: string, fullText: string}>}
   */
  static parse(lrcText, timeOffset = 0) {
    if (!lrcText || typeof lrcText !== 'string') return [];

    const lyrics = [];

    for (const raw of lrcText.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;

      // 建议将正则声明在循环/函数外部，避免重复编译
      const LYRIC_TIME_REGEX = /^\[(\d{1,2}):(\d{2})\.(\d{2,3})\](.*)/;

      // 循环内部代码：
      const match = line.match(LYRIC_TIME_REGEX);
      if (!match) continue;

      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      if (seconds >= 60) continue; // 校验秒数范围

      // 将 2/3 位毫秒统一转化为秒（例："4"->0.4s, "45"->0.45s, "456"->0.456s）
      const fraction = Number(`0.${match[3]}`);
      const rawTime = minutes * 60 + seconds + fraction - timeOffset;
      const time = Math.round(rawTime * 1000) / 1000;  // 保留三位小数，避免浮点数精度问题
      
      const text = match[4].trim(); // 提取后的歌词内容

      const [english = '', chinese = ''] = text.split('|').map((part) => part.trim());

      if (!english) continue;

      lyrics.push({ time, english, chinese, fullText: text });
    }

    return lyrics.sort((a, b) => a.time - b.time);
  }
}
