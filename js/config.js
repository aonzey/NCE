/**
 * 全局常量
 * @module config
 */

export const CONFIG = {
  DEFAULT_BOOK_KEY: 'YL5A',

  STORAGE_KEYS: {
    BOOK_SELECTION: 'selectedBookKey',
    LOOP_MODE: 'loopMode',
    LOOP_COUNT: 'loopCount',
    LOOP_INTERVAL: 'loopInterval',
    PLAYBACK_RATE: 'playbackRate',
    TRANSLATION_MODE: 'translationMode',
    LYRIC_SCALE: 'lyricScale',
    THEME: 'theme',
  },

  AVAILABLE_SPEEDS: [0.5, 0.75, 1.0, 1.25, 1.5, 2.0],
  /**
   * 单句循环次数选项（0 表示无限循环）
   * @type {number[]}
   */
  LOOP_COUNT_OPTIONS: [0, 2, 3, 5, 10],
  /**
   * 单句循环间隔时间选项（单位：秒）
   * @type {number[]}
   */
  LOOP_INTERVAL_OPTIONS: [0, 0.5, 1, 2, 3],
  TRANSLATION_MODES: ['show', 'english', 'chinese', 'blur'],
  LOOP_MODES: ['off', 'click', 'one', 'list', 'book'],
  /**
   * 歌词文本字号档位（相对倍率，作用于 .lyrics-container 内歌词）
   * @type {number[]}
   */
  LYRIC_SCALE_OPTIONS: [0.85, 1, 1.3, 2, 3],
  /** 字号档位显示名，与 LYRIC_SCALE_OPTIONS 一一对应 */
  LYRIC_SCALE_LABELS: ['小', '标准', '大', '特大', '最大'],

  PLAYER: {
    MAX_AUDIO_CACHE: 3,
    MAX_LRC_CACHE: 3,
    TIME_OFFSET: 0.3,
  },

  UI: {
    LYRIC_SCROLL_THRESHOLD: 0.1,
    THEME_ANIMATION_DURATION: 300,
    MODAL_ANIMATION_DURATION: 200,
  },

  ERROR_MESSAGES: {
    LOAD_BOOKS: '加载课本数据失败',
    LOAD_CONFIG: '课件配置加载失败',
    LOAD_LYRIC: '加载歌词失败',
    NO_DATA: '未找到可用课本数据',
    LOAD_FAILED: '加载失败',
  },
};

export function createInitialState() {
  return {
    books: [],
    units: [],
    bookPath: '',
    bookKey: '',
    currentLyrics: [],
    currentLyricIndex: -1,
    currentUnitIndex: -1,
    loopMode: 'off',
    loopCount: 0,
    loopInterval: 0,
    sentenceLoopIndex: -1,
    sentenceRepeatCount: 1,
    playbackRate: 1.0,
    translationMode: 'show',
    lyricScale: 1,
  };
}
