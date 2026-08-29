/**
 * 阅读系统协调器：课本、单元、歌词、播放与偏好
 * @module ReadingSystem
 */

import { CONFIG, createInitialState } from './config.js';
import { qs, qsa, on, setText, toggleClass } from './utils/dom.js';
import { clamp, debounce } from './utils/helpers.js';
import {
  getStorage,
  setStorage,
  getPlayTime,
  savePlayTime,
  getCurrentUnitIndex,
  saveCurrentUnitIndex,
} from './utils/storage.js';
import { LRCParser } from './utils/LRCParser.js';
import { BookService } from './services/BookService.js';
import { PrefetchService } from './services/PrefetchService.js';
import { AudioController } from './player/AudioController.js';
import { LyricsView } from './ui/LyricsView.js';
import { UnitView } from './ui/UnitView.js';
import { Toast } from './ui/Toast.js';

const LOOP_MODE_LABELS = {
  off: '关闭循环',
  click: '单句点读',
  one: '单句循环',
  list: '本课循环',
  book: '本书循环',
};

const TRANSLATION_LABELS = {
  show: '显示双语',
  english: '仅显示英文',
  chinese: '仅显示中文',
  blur: '模糊翻译',
};

export class ReadingSystem {
  constructor() {
    this.config = CONFIG;
    this.state = createInitialState();
    this.bookService = new BookService();
    this.prefetch = new PrefetchService({
      maxLrc: CONFIG.PLAYER.MAX_LRC_CACHE,
      maxAudio: CONFIG.PLAYER.MAX_AUDIO_CACHE,
    });

    this.bookAbort = null;
    this.unitAbort = null;
    this.unitLoadId = 0;
    this.ready = false;
    this.persistProgress = debounce(() => this.#saveProgress(), 1500);

    this.player = new AudioController({
      audio: qs('#audioPlayer'),
      playBtn: qs('#playPauseBtn'),
      progressBar: qs('#progressBar'),
      currentTimeEl: qs('#currentTime'),
      durationEl: qs('#duration'),
      onTick: (currentTime, duration) => this.#onAudioTick(currentTime, duration),
      onPersist: () => this.#saveProgress(),
      onEnded: () => this.#onAudioEnded(),
      onLoaded: () => this.toast.show('音频已加载', { type: 'success' }),
      onUserPause: () => this.#cancelSentenceRestart(),
    });

    this.lyricsView = new LyricsView({
      display: qs('#lyricsDisplay'),
      container: qs('.lyrics-container'),
      scrollThreshold: CONFIG.UI.LYRIC_SCROLL_THRESHOLD,
      onActivate: (index, time) => this.#onLyricActivate(index, time),
    });

    this.unitView = new UnitView({
      unitList: qs('#unitListContainer'),
      unitSelect: qs('#unitSelect'),
      bookSelects: qsa('.book-select'),
      bookCover: qs('#bookCover'),
      bookTitle: qs('#bookTitle'),
      bookHint: qs('#bookHint'),
      prevBtn: qs('#prevUnitBtn'),
      nextBtn: qs('#nextUnitBtn'),
      onUnitChange: (value) => this.#onUnitNavigate(value),
      onBookChange: (bookKey) => this.#onBookSelect(bookKey),
    });

    this.speedBtn = qs('#speedBtn');
    this.speedText = qs('#speedText');
    this.loopToggleBtn = qs('#loopToggleBtn');
    this.loopSettingsBtn = qs('#loopSettingsBtn');
    this.loopSettingsPanel = qs('#loopSettingsPanel');
    this.loopCountSelect = qs('#loopCountSelect');
    this.loopIntervalSelect = qs('#loopIntervalSelect');
    this.toggleTranslationBtn = qs('#toggleTranslationBtn');
    this.lyricSizeBtn = qs('#lyricSizeBtn');
    this.lyricSizeText = qs('#lyricSizeText');
    this.lyricsContainerEl = qs('.lyrics-container');

    this.sentenceRestartTimer = null;
    this.sentenceLoopToken = 0;
    this.pendingRestartStartTime = 0;

    this.toast = new Toast();

    this.abort = new AbortController();
    this.#bindChrome();
    this.init();
  }

  async init() {
    try {
      this.#restorePreferences();
      this.state.books = await this.bookService.loadCatalog();
      await this.applyBookFromHash();
      await this.loadUnitFromStorage();
    } catch (error) {
      if (error?.name === 'AbortError') return;
      console.error('Failed to initialize ReadingSystem:', error);
      this.lyricsView.setEmpty(this.config.ERROR_MESSAGES.LOAD_BOOKS);
    }
  }

  async applyBookFromHash() {
    const keyFromHash = location.hash.slice(1).trim();
    const storedBookKey = getStorage(this.config.STORAGE_KEYS.BOOK_SELECTION);
    const initialBookKey = keyFromHash || storedBookKey || this.config.DEFAULT_BOOK_KEY;
    await this.applyBookChange(initialBookKey);
  }

  async applyBookChange(bookKey) {
    this.bookAbort?.abort();
    this.unitAbort?.abort();
    this.unitLoadId += 1;
    this.bookAbort = new AbortController();
    const { signal } = this.bookAbort;

    if (!this.state.books.length) {
      this.state.books = await this.bookService.loadCatalog(signal);
    }

    const resolved = this.bookService.resolve(bookKey, this.config.DEFAULT_BOOK_KEY);
    const resolvedPath = resolved?.path || resolved?.bookPath;
    if (!resolvedPath) {
      this.state.bookPath = '';
      this.state.bookKey = '';
      this.state.units = [];
      this.unitView.clearUnits();
      this.unitView.setBookMeta(null);
      this.lyricsView.setEmpty(this.config.ERROR_MESSAGES.NO_DATA);
      return;
    }

    this.state.bookKey = resolved.key || bookKey;
    this.state.bookPath = resolvedPath.trim().replace(/\/$/, '');
    setStorage(this.config.STORAGE_KEYS.BOOK_SELECTION, this.state.bookKey);
    this.unitView.renderBooks(this.state.books, this.state.bookKey);
    this.unitView.setBookMeta(resolved);

    this.persistProgress.cancel();
    this.#saveProgress();
    this.ready = false;
    this.player.reset();
    this.state.currentUnitIndex = -1;
    this.state.currentLyrics = [];
    this.lyricsView.setEmpty('加载中...');
    this.prefetch.clear();

    try {
      const { units, coverUrl, bookName, bookLevel } = await this.bookService.loadBook(resolved, signal);
      this.state.units = units;
      this.unitView.setCover(coverUrl);
      this.unitView.setBookMeta({
        ...resolved,
        bookName,
        bookLevel,
      });
      this.unitView.renderUnits(units);
      this.unitView.resetListScroll();
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      console.error(this.config.ERROR_MESSAGES.LOAD_CONFIG, error);
      this.state.units = [];
      this.unitView.clearUnits();
      this.lyricsView.setEmpty(
        `${this.config.ERROR_MESSAGES.LOAD_CONFIG}: ${this.state.bookPath}/book.json`
      );
    }
  }

  async loadUnitFromStorage() {
    if (!this.state.units.length) return;
    const unitIndex = getCurrentUnitIndex(this.state.bookKey);
    const safeIndex = clamp(unitIndex, 0, this.state.units.length - 1);
    await this.loadUnitByIndex(safeIndex, { scroll: true });
  }

  async loadUnitByIndex(unitIndex, options = {}) {
    const unit = this.state.units[unitIndex];
    if (!unit) return;
    if (unitIndex === this.state.currentUnitIndex && this.ready) return;

    this.unitAbort?.abort();
    this.unitAbort = new AbortController();
    const { signal } = this.unitAbort;
    const loadId = ++this.unitLoadId;

    this.persistProgress.cancel();
    this.#saveProgress();
    this.ready = false;
    this.state.currentUnitIndex = unitIndex;
    this.state.currentLyricIndex = -1;
    this.state.sentenceLoopIndex = -1;
    this.state.sentenceRepeatCount = 1;
    this.#cancelSentenceRestart();
    this.state.currentLyrics = [];
    saveCurrentUnitIndex(this.state.bookKey, unitIndex);

    this.player.reset();
    this.unitView.setActive(unitIndex, { scroll: options.scroll });
    this.unitView.updateNav(unitIndex, this.state.units.length);

    try {
      const lrcText = await this.prefetch.loadLrc(unit.lrc, signal);
      if (loadId !== this.unitLoadId) return;
      this.state.currentLyrics = LRCParser.parse(lrcText, this.config.PLAYER.TIME_OFFSET);
      this.lyricsView.render(this.state.currentLyrics);
    } catch (error) {
      if (error?.name === 'AbortError' || loadId !== this.unitLoadId) return;
      console.error(this.config.ERROR_MESSAGES.LOAD_LYRIC, error);
      this.lyricsView.setEmpty(this.config.ERROR_MESSAGES.LOAD_FAILED);
    }

    if (loadId !== this.unitLoadId) return;

    this.player.setSrc(unit.audio, {
      loop: this.state.loopMode === 'list',
      playbackRate: this.state.playbackRate,
      startTime: getPlayTime(this.state.bookKey, unitIndex),
    });
    this.ready = true;

    this.prefetch.prefetch(this.state.units[unitIndex + 1]);
  }

  destroy() {
    this.#cancelSentenceRestart();
    this.#saveProgress();
    this.bookAbort?.abort();
    this.unitAbort?.abort();
    this.abort.abort();
    this.player.destroy();
    this.lyricsView.destroy();
    this.unitView.destroy();
    this.prefetch.clear();
    this.toast.destroy();
  }

  #bindChrome() {
    const { signal } = this.abort;

    on(this.speedBtn, 'click', () => this.#cycleSpeed(), { signal });
    on(this.loopToggleBtn, 'click', () => this.#cycleLoopMode(), { signal });
    on(this.toggleTranslationBtn, 'click', () => this.#cycleTranslation(), { signal });
    if (this.lyricSizeBtn) {
      on(this.lyricSizeBtn, 'click', () => this.#cycleLyricSize(), { signal });
    }

    if (this.loopSettingsBtn) {
      on(this.loopSettingsBtn, 'click', (event) => {
        event.stopPropagation();
        this.#toggleLoopSettings();
      }, { signal });
    }
    if (this.loopCountSelect) {
      on(this.loopCountSelect, 'change', (event) => this.#onLoopCountChange(event), { signal });
    }
    if (this.loopIntervalSelect) {
      on(this.loopIntervalSelect, 'change', (event) => this.#onLoopIntervalChange(event), { signal });
    }
    if (this.loopSettingsPanel) {
      on(document, 'click', (event) => {
        if (this.loopSettingsPanel.hidden) return;
        if (this.loopSettingsPanel.contains(event.target)) return;
        if (this.loopSettingsBtn?.contains(event.target)) return;
        this.#toggleLoopSettings(false);
      }, { signal });
      on(document, 'keydown', (event) => {
        if (event.key === 'Escape' && !this.loopSettingsPanel.hidden) {
          this.#toggleLoopSettings(false);
        }
      }, { signal });
    }

    on(window, 'hashchange', () => {
      const newKey = location.hash.slice(1).trim() || this.config.DEFAULT_BOOK_KEY;
      if (newKey === this.state.bookKey) return;
      this.applyBookChange(newKey)
        .then(() => this.loadUnitFromStorage())
        .catch((error) => {
          if (error?.name !== 'AbortError') {
            console.error('Failed to switch book:', error);
          }
        });
    }, { signal });

    on(document, 'visibilitychange', () => {
      if (document.hidden) this.#saveProgress();
    }, { signal });

    on(window, 'pagehide', () => this.#saveProgress(), { signal });
  }

  #restorePreferences() {
    const storedLoop = getStorage(this.config.STORAGE_KEYS.LOOP_MODE);
    if (this.config.LOOP_MODES.includes(storedLoop)) {
      this.state.loopMode = storedLoop;
    } else if (getStorage('loopPlaybackEnabled') === 'true') {
      this.state.loopMode = 'list';
    }

    const storedLoopCount = Number(getStorage(this.config.STORAGE_KEYS.LOOP_COUNT));
    if (this.config.LOOP_COUNT_OPTIONS.includes(storedLoopCount)) {
      this.state.loopCount = storedLoopCount;
    }

    const storedLoopInterval = Number(getStorage(this.config.STORAGE_KEYS.LOOP_INTERVAL));
    if (this.config.LOOP_INTERVAL_OPTIONS.includes(storedLoopInterval)) {
      this.state.loopInterval = storedLoopInterval;
    }

    const storedSpeed = parseFloat(getStorage(this.config.STORAGE_KEYS.PLAYBACK_RATE));
    if (this.config.AVAILABLE_SPEEDS.includes(storedSpeed)) {
      this.state.playbackRate = storedSpeed;
    }

    const storedTranslation = getStorage(this.config.STORAGE_KEYS.TRANSLATION_MODE);
    if (this.config.TRANSLATION_MODES.includes(storedTranslation)) {
      this.state.translationMode = storedTranslation;
    }

    const storedLyricScale = parseFloat(getStorage(this.config.STORAGE_KEYS.LYRIC_SCALE));
    if (this.config.LYRIC_SCALE_OPTIONS.includes(storedLyricScale)) {
      this.state.lyricScale = storedLyricScale;
    }

    this.player.setLoop(this.state.loopMode === 'list');
    this.player.setRate(this.state.playbackRate);
    this.#updateSpeedUI();
    this.#updateLoopUI();
    this.#updateLoopSettingsUI();
    this.#applyLyricScale();
    this.lyricsView.applyTranslationMode(this.state.translationMode, this.toggleTranslationBtn);
  }

  #onBookSelect(bookKey) {
    if (!bookKey || location.hash.slice(1) === bookKey) return;
    location.hash = bookKey;
  }

  #onUnitNavigate(value) {
    if (value === 'prev') {
      if (this.state.currentUnitIndex > 0) {
        this.loadUnitByIndex(this.state.currentUnitIndex - 1);
      }
      return;
    }
    if (value === 'next') {
      if (this.state.currentUnitIndex < this.state.units.length - 1) {
        this.loadUnitByIndex(this.state.currentUnitIndex + 1);
      }
      return;
    }
    if (Number.isFinite(value) && value >= 0) {
      this.loadUnitByIndex(value);
    }
  }

  #onLyricActivate(index, time) {
    if (this.state.loopMode === 'one' || this.state.loopMode === 'click') {
      if (index !== this.state.sentenceLoopIndex) {
        this.#cancelSentenceRestart();
      }
      this.state.sentenceLoopIndex = index;
      this.state.sentenceRepeatCount = 1;
    }
    this.#setHighlight(index);
    this.player.seek(time);
    this.player.play();
    this.#saveProgress(time);
  }

  #onAudioTick(currentTime, duration) {
    if (!this.ready) return;
    this.#handleSentence(currentTime, duration);
    this.#syncHighlight();
    this.persistProgress();
  }

  #lockedSentenceIndex() {
    if (this.state.loopMode !== 'click' && this.state.loopMode !== 'one') return -1;
    return this.state.sentenceLoopIndex;
  }

  #setHighlight(index) {
    if (index === this.state.currentLyricIndex) return;
    this.lyricsView.highlight(index);
    this.state.currentLyricIndex = index;
  }

  #syncHighlight() {
    const locked = this.#lockedSentenceIndex();
    const index = locked >= 0
      ? locked
      : LRCParser.findLyricIndexByTime(this.state.currentLyrics, this.player.currentTime);

    // 单句循环模式：上一句循环完成后自动锁定下一句，保持整课逐句循环
    if (locked < 0 && this.state.loopMode === 'one' && index >= 0 && index !== this.state.currentLyricIndex) {
      this.state.sentenceLoopIndex = index;
      this.state.sentenceRepeatCount = 1;
    }

    this.#setHighlight(index);
  }

  #handleSentence(currentTime, duration) {
    const locked = this.#lockedSentenceIndex();
    if (locked < 0 || !Number.isFinite(currentTime)) return;

    const boundaries = LRCParser.getSentenceBoundaries(
      this.state.currentLyrics,
      locked,
      duration
    );
    if (!boundaries || !Number.isFinite(boundaries.startTime)) return;

    const endTime = boundaries.endTime;
    if (currentTime < endTime) return;

    if (this.state.loopMode === 'click') {
      const loopCount = this.state.loopCount;
      const isInfinite = !Number.isFinite(loopCount) || loopCount <= 0;

      // 未设置循环次数时保持点读原行为：播完一遍回到句首并暂停
      if (isInfinite) {
        this.player.seek(boundaries.startTime);
        this.player.pause();
        this.#setHighlight(locked);
        return;
      }

      // 达到指定次数：回到句首并暂停，等待下一次点读
      if (this.state.sentenceRepeatCount >= loopCount) {
        this.state.sentenceLoopIndex = -1;
        this.state.sentenceRepeatCount = 0;
        this.#cancelSentenceRestart();
        this.player.seek(boundaries.startTime);
        this.player.pause();
        this.#setHighlight(locked);
        this.toast.show('点读完成');
        return;
      }

      // 未达到次数：按间隔时间继续重播
      this.state.sentenceRepeatCount += 1;
      this.#restartSentence(boundaries.startTime);
      this.#setHighlight(locked);
      return;
    }

    // 单句循环：按「循环次数 + 间隔时间」控制重复
    const loopCount = this.state.loopCount;
    const isInfinite = !Number.isFinite(loopCount) || loopCount <= 0;
    if (!isInfinite && this.state.sentenceRepeatCount >= loopCount) {
      this.state.sentenceLoopIndex = -1;
      this.state.sentenceRepeatCount = 0;
      return;
    }

    this.state.sentenceRepeatCount += 1;
    this.#restartSentence(boundaries.startTime);
    this.#setHighlight(locked);
  }

  /**
   * 将当前句子跳回起点重新播放；设置了间隔时间时先暂停，等待间隔后再继续
   * @param {number} startTime 句子起始时间（秒）
   */
  #restartSentence(startTime) {
    this.#cancelSentenceRestart();
    this.pendingRestartStartTime = startTime;
    const intervalMs = Math.max(0, Number(this.state.loopInterval) || 0) * 1000;
    if (intervalMs <= 0) {
      this.player.seek(startTime);
      return;
    }

    this.player.pause();
    const token = this.sentenceLoopToken;
    this.sentenceRestartTimer = setTimeout(() => {
      this.sentenceRestartTimer = null;
      if (token !== this.sentenceLoopToken) return;
      this.player.seek(startTime);
      this.player.play();
    }, intervalMs);
  }

  /** 取消待执行的循环重启定时器并作废其 token */
  #cancelSentenceRestart() {
    this.sentenceLoopToken += 1;
    if (this.sentenceRestartTimer) {
      clearTimeout(this.sentenceRestartTimer);
      this.sentenceRestartTimer = null;
    }
  }

  #cycleSpeed() {
    const speeds = this.config.AVAILABLE_SPEEDS;
    const currentIndex = speeds.indexOf(this.state.playbackRate);
    this.state.playbackRate = speeds[(currentIndex + 1) % speeds.length];
    this.player.setRate(this.state.playbackRate);
    setStorage(this.config.STORAGE_KEYS.PLAYBACK_RATE, this.state.playbackRate);
    this.#updateSpeedUI();
    this.toast.show(`播放速度 ${this.state.playbackRate}x`);
  }

  #updateSpeedUI() {
    setText(this.speedText, `${this.state.playbackRate}x`);
    toggleClass(this.speedBtn, 'active', this.state.playbackRate !== 1.0);
  }

  #onAudioEnded() {
    this.#saveProgress();
    if (!this.state.units.length) return;

    if (this.state.loopMode === 'book') {
      const nextIndex = (this.state.currentUnitIndex + 1) % this.state.units.length;
      this.loadUnitByIndex(nextIndex).then(() => {
        this.player.play();
      });
    }
  }

  #cycleLoopMode() {
    const modes = this.config.LOOP_MODES;
    const nextMode = modes[(modes.indexOf(this.state.loopMode) + 1) % modes.length];
    this.state.loopMode = nextMode;

    if (nextMode === 'one' || nextMode === 'click') {
      if (this.state.currentLyricIndex >= 0) {
        this.state.sentenceLoopIndex = this.state.currentLyricIndex;
      }
      this.state.sentenceRepeatCount = 1;
    }
    if (nextMode === 'list' || nextMode === 'off' || nextMode === 'book') {
      this.state.sentenceLoopIndex = -1;
      this.state.sentenceRepeatCount = 0;
      this.#cancelSentenceRestart();
    }

    setStorage(this.config.STORAGE_KEYS.LOOP_MODE, nextMode);
    this.player.setLoop(nextMode === 'list');
    this.#updateLoopUI();
    this.#syncHighlight();
    this.toast.show(LOOP_MODE_LABELS[nextMode]);
  }

  #updateLoopUI() {
    if (!this.loopToggleBtn) return;

    const mode = this.state.loopMode;
    const isClick = mode === 'click';
    const isOne = mode === 'one';
    const isList = mode === 'list';
    const isBook = mode === 'book';

    this.loopToggleBtn.setAttribute('aria-pressed', mode !== 'off' ? 'true' : 'false');
    toggleClass(this.loopToggleBtn, 'list', isList);
    toggleClass(this.loopToggleBtn, 'click', isClick);
    toggleClass(this.loopToggleBtn, 'one', isOne);
    toggleClass(this.loopToggleBtn, 'book', isBook);

    let label = LOOP_MODE_LABELS[mode] || '循环播放';
    const hasLoopLimit = (Number(this.state.loopCount) || 0) > 0;
    if (isOne || (isClick && hasLoopLimit)) {
      label = `${label} · ${this.#loopCountLabel()} · ${this.#loopIntervalLabel()}`;
    }
    this.loopToggleBtn.title = label;
    this.loopToggleBtn.setAttribute('aria-label', label);

    if (this.loopSettingsBtn) {
      const enabled = isOne || isClick;
      this.loopSettingsBtn.disabled = !enabled;
      toggleClass(this.loopSettingsBtn, 'active', enabled);
      if (!enabled && this.loopSettingsPanel && !this.loopSettingsPanel.hidden) {
        this.#toggleLoopSettings(false);
      }
    }
  }

  /** 循环次数文案 */
  #loopCountLabel() {
    const count = Number(this.state.loopCount) || 0;
    return count > 0 ? `循环 ${count} 次` : '无限循环';
  }

  /** 循环间隔文案 */
  #loopIntervalLabel() {
    const interval = Number(this.state.loopInterval) || 0;
    return interval > 0 ? `间隔 ${interval} 秒` : '无间隔';
  }

  /** 将状态同步到设置面板控件 */
  #updateLoopSettingsUI() {
    if (this.loopCountSelect) {
      this.loopCountSelect.value = String(this.state.loopCount);
    }
    if (this.loopIntervalSelect) {
      this.loopIntervalSelect.value = String(this.state.loopInterval);
    }
  }

  /**
   * 展开/收起单句循环设置面板
   * @param {boolean} [force]
   */
  #toggleLoopSettings(force) {
    if (!this.loopSettingsPanel || !this.loopSettingsBtn) return;
    const show = typeof force === 'boolean' ? force : this.loopSettingsPanel.hidden;
    this.loopSettingsPanel.hidden = !show;
    this.loopSettingsBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) this.#updateLoopSettingsUI();
  }

  #onLoopCountChange(event) {
    const value = Number(event.target.value);
    if (!this.config.LOOP_COUNT_OPTIONS.includes(value)) return;
    this.state.loopCount = value;
    this.state.sentenceRepeatCount = 1;
    if (this.sentenceRestartTimer !== null) {
      this.#restartSentence(this.pendingRestartStartTime);
    }
    setStorage(this.config.STORAGE_KEYS.LOOP_COUNT, value);
    this.#updateLoopUI();
    this.toast.show(`循环次数：${this.#loopCountLabel()}`);
  }

  #onLoopIntervalChange(event) {
    const value = Number(event.target.value);
    if (!this.config.LOOP_INTERVAL_OPTIONS.includes(value)) return;
    this.state.loopInterval = value;
    if (this.sentenceRestartTimer !== null) {
      this.#restartSentence(this.pendingRestartStartTime);
    }
    setStorage(this.config.STORAGE_KEYS.LOOP_INTERVAL, value);
    this.#updateLoopUI();
    this.toast.show(`循环间隔：${this.#loopIntervalLabel()}`);
  }

  #cycleTranslation() {
    const modes = this.config.TRANSLATION_MODES;
    const currentIndex = modes.indexOf(this.state.translationMode);
    this.state.translationMode = modes[(currentIndex + 1) % modes.length];
    setStorage(this.config.STORAGE_KEYS.TRANSLATION_MODE, this.state.translationMode);
    this.lyricsView.applyTranslationMode(this.state.translationMode, this.toggleTranslationBtn);
    this.toast.show(TRANSLATION_LABELS[this.state.translationMode]);
  }

  /** 歌词字号档位文案 */
  #lyricScaleLabel() {
    const scale = Number(this.state.lyricScale) || 1;
    if (scale < 0.9) return '小';
    if (scale < 1.05) return '标准';
    if (scale < 1.2) return '大';
    if (scale < 1.4) return '特大';
    return '最大';
  }

  /** 将字号档位写入 CSS 变量并更新按钮状态 */
  #applyLyricScale() {
    const scale = Number(this.state.lyricScale) || 1;
    this.lyricsContainerEl?.style.setProperty('--lyric-scale', scale);
    if (this.lyricSizeBtn) {
      this.lyricSizeBtn.title = `字号：${this.#lyricScaleLabel()}`;
      this.lyricSizeBtn.setAttribute('aria-label', `调节歌词字号（当前${this.#lyricScaleLabel()}）`);
      toggleClass(this.lyricSizeBtn, 'active', scale !== 1);
    }
    if (this.lyricSizeText) {
      this.lyricSizeText.style.fontSize = `${(15 + (scale - 1) * 10).toFixed(1)}px`;
    }
  }

  #cycleLyricSize() {
    const options = this.config.LYRIC_SCALE_OPTIONS;
    const currentIndex = options.indexOf(this.state.lyricScale);
    this.state.lyricScale = options[(currentIndex + 1) % options.length];
    setStorage(this.config.STORAGE_KEYS.LYRIC_SCALE, this.state.lyricScale);
    this.#applyLyricScale();
    this.toast.show(`字号：${this.#lyricScaleLabel()}`);
  }

  #saveProgress(time = this.player.currentTime) {
    if (!this.ready) return;
    if (!this.state.bookKey || this.state.currentUnitIndex < 0) return;
    if (!Number.isFinite(time) || time < 0) return;
    savePlayTime(this.state.bookKey, this.state.currentUnitIndex, time);
  }
}
