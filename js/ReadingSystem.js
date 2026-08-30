/**
 * 阅读系统协调器：课本、单元、歌词、播放与偏好
 * @module ReadingSystem
 */

import { CONFIG, createInitialState } from './config.js';
import { qs, qsa, on, setText, toggleClass } from './utils/dom.js';
import { clamp, throttle } from './utils/helpers.js';
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
import { ImportService } from './services/ImportService.js';
import { AudioController } from './player/AudioController.js';
import { LyricsView } from './ui/LyricsView.js';
import { UnitView } from './ui/UnitView.js';
import { Toast } from './ui/Toast.js';
import { ImportPanel } from './ui/ImportPanel.js';

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
    // 进度回调已改为逐帧触发，这里必须用节流而非防抖：
    // 防抖会被每帧调用无限推迟，导致播放过程中的进度一次都不落盘
    this.persistProgress = throttle(() => this.#saveProgress(), 2000);

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

    this.importService = new ImportService();
    this.importPanel = new ImportPanel({
      triggerBtn: qs('#importBtn'),
      panel: qs('#importPanel'),
      importService: this.importService,
      toast: (message, opts) => this.toast.show(message, opts),
      onImported: (book) => this.#onBookImported(book),
      onDeleted: (bookKey) => this.#onBookDeleted(bookKey),
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
    this.lyricSizePanel = qs('#lyricSizePanel');
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
      await this.#restoreImportedBooks();
      await this.applyBookFromHash();
      await this.loadUnitFromStorage();
    } catch (error) {
      if (error?.name === 'AbortError') return;
      console.error('Failed to initialize ReadingSystem:', error);
      this.lyricsView.setEmpty(this.config.ERROR_MESSAGES.LOAD_BOOKS);
    }
  }

  /** 启动时恢复 IndexedDB 中的自定义课本，并入课本列表 */
  async #restoreImportedBooks() {
    try {
      const customBooks = await this.importService.restoreAll();
      if (!customBooks.length) return;
      // 注意：state.books 与 bookService.books 是同一引用，去重后只 push 一次
      for (const book of customBooks) {
        if (this.state.books.some((b) => b.key === book.key)) continue;
        this.state.books.push(book);
      }
    } catch (error) {
      console.error('Failed to restore imported books:', error);
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
    if (!resolvedPath && !resolved?.custom) {
      this.state.bookPath = '';
      this.state.bookKey = '';
      this.state.units = [];
      this.unitView.clearUnits();
      this.unitView.setBookMeta(null);
      this.#showImportPrompt(this.config.ERROR_MESSAGES.NO_DATA);
      return;
    }

    this.state.bookKey = resolved.key || bookKey;
    this.state.bookPath = (resolvedPath || '').trim().replace(/\/$/, '');
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
      const { units, coverUrl, bookName, bookLevel } = resolved.custom
        ? await this.importService.loadBook(resolved)
        : await this.bookService.loadBook(resolved, signal);
      this.state.units = units;
      this.unitView.setCover(coverUrl);
      this.unitView.setBookMeta({
        ...resolved,
        bookName,
        bookLevel,
      });
      this.unitView.renderUnits(units);
      this.unitView.resetListScroll();

      // 拉取成功但一门课都没有（镜像目录为空）：同样引导用户导入
      if (!units.length) {
        this.#showImportPrompt(`「${bookName || this.state.bookKey}」暂时没有可用课程`);
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      console.error(this.config.ERROR_MESSAGES.LOAD_CONFIG, error);
      this.state.units = [];
      this.unitView.clearUnits();
      // 默认课本拉不到（离线 / 镜像不可用）：引导导入，而不是只丢一句看不懂的报错
      this.#showImportPrompt(
        `${this.config.ERROR_MESSAGES.LOAD_CONFIG}：${this.state.bookPath}/book.json`
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
    this.importPanel?.destroy();
    this.prefetch.clear();
    this.toast.destroy();
  }

  #bindChrome() {
    const { signal } = this.abort;

    on(this.speedBtn, 'click', () => this.#cycleSpeed(), { signal });
    on(this.loopToggleBtn, 'click', () => this.#cycleLoopMode(), { signal });
    on(this.toggleTranslationBtn, 'click', () => this.#cycleTranslation(), { signal });
    if (this.lyricSizeBtn) {
      on(this.lyricSizeBtn, 'click', (event) => {
        event.stopPropagation();
        this.#toggleLyricSizePanel();
      }, { signal });
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
    if (this.lyricSizePanel) {
      this.#renderLyricSizeOptions();
      on(document, 'click', (event) => {
        if (this.lyricSizePanel.hidden) return;
        if (this.lyricSizePanel.contains(event.target)) return;
        if (this.lyricSizeBtn?.contains(event.target)) return;
        this.#toggleLyricSizePanel(false);
      }, { signal });
      on(document, 'keydown', (event) => {
        if (event.key === 'Escape' && !this.lyricSizePanel.hidden) {
          this.#toggleLyricSizePanel(false);
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

  /** 导入完成后切换到新书 */
  #onBookImported(book) {
    if (!book?.key) return;
    if (!this.state.books.some((b) => b.key === book.key)) {
      // state.books 与 bookService.books 同一引用，push 一次即可
      this.state.books.push({ key: book.key, title: book.title, custom: true });
    }
    // 同步 hash（不触发 hashchange），保证刷新后仍停留在新书
    if (location.hash.slice(1) !== book.key) {
      history.replaceState(null, '', `#${book.key}`);
    }
    this.applyBookChange(book.key)
      .then(() => this.loadUnitFromStorage())
      .catch((error) => {
        if (error?.name !== 'AbortError') {
          console.error('Failed to switch to imported book:', error);
        }
      });
  }

  /** 删除导入课本后同步列表；若当前正在使用则回到默认课本 */
  #onBookDeleted(bookKey) {
    // state.books 与 bookService.books 是同一数组引用，必须原地过滤以保持共享
    const books = this.state.books;
    for (let i = books.length - 1; i >= 0; i -= 1) {
      if (books[i]?.key === bookKey) books.splice(i, 1);
    }
    this.prefetch.clear();
    // 删除的是非当前课本时不会走切换流程，需手动刷新下拉，否则残留已删除项
    this.unitView.renderBooks(books, this.state.bookKey);

    if (this.state.bookKey === bookKey) {
      const fallback = this.config.DEFAULT_BOOK_KEY;
      if (location.hash.slice(1) === fallback) {
        this.applyBookChange(fallback)
          .then(() => this.loadUnitFromStorage())
          .catch(() => {});
      } else {
        location.hash = fallback; // hashchange 监听器会接管切换
      }
    }
  }

  /**
   * 默认课本拿不到内容时（离线 / 镜像不可用 / 目录为空），
   * 明确引导用户去点「导入」按钮加载自己的资料，而不是只丢一句看不懂的报错。
   * @param {string} reason 具体原因，会展示在提示文字里
   */
  #showImportPrompt(reason) {
    this.lyricsView.setEmpty(
      `${reason}\n可以导入自己的 MP3 + LRC 开始学习。`,
      { label: '导入学习资料', onClick: () => this.#openImportPanel() }
    );
  }

  /** 打开导入面板：复用导入按钮自身的开合逻辑（含 aria-expanded、点击外部关闭） */
  #openImportPanel() {
    this.importPanel?.triggerBtn?.click();
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
    if (!Number.isFinite(endTime)) return;
    // 提前量：抵消帧间隔与 seek 延迟（二者换算到音频时间都会被倍速放大），
    // 避免真正越过句尾、漏出下一句开头
    if (currentTime + this.#sentenceLead(endTime - boundaries.startTime) < endTime) return;

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
   * 句尾检测的提前量（秒）：在真正到达 endTime 之前就跳回句首。
   * 检测以 rAF 逐帧进行，帧间隔乘以倍速就是最坏情况下的越界长度，
   * 再叠加一点余量覆盖 seek 的解码延迟。
   * @param {number} span 句子时长，避免提前量吃掉过短的句子
   */
  #sentenceLead(span) {
    const rate = Math.max(1, Number(this.player.playbackRate) || 1);
    const lead = 0.02 + rate * 0.02;
    const safe = Number.isFinite(span) && span > 0 ? Math.min(lead, span * 0.25) : lead;
    return Math.min(safe, 0.2);
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

  /**
   * 预览字号：按钮上的 A 与面板选项文字共用。
   * 系数需保守，否则最大档会把固定尺寸的控制按钮撑变形。
   */
  #previewFontSize(scale) {
    return `${(14 + (scale - 1) * 6).toFixed(1)}px`;
  }

  /** 歌词字号档位文案（阈值需与 LYRIC_SCALE_OPTIONS 的取值范围匹配） */
  #lyricScaleLabel() {
    const scale = Number(this.state.lyricScale) || 1;
    if (scale < 0.9) return '小';
    if (scale < 1.15) return '标准';
    if (scale < 1.7) return '大';
    if (scale < 2.5) return '特大';
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
      this.lyricSizeText.style.fontSize = this.#previewFontSize(scale);
    }
  }

  /** 渲染字号选项面板；选项文字本身按档位缩放，便于直观预览 */
  #renderLyricSizeOptions() {
    const options = this.config.LYRIC_SCALE_OPTIONS;
    const labels = this.config.LYRIC_SCALE_LABELS;
    const { signal } = this.abort;
    this.lyricSizePanel.replaceChildren();
    options.forEach((scale, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'lyric-size-option';
      option.dataset.scale = String(scale);

      const name = document.createElement('span');
      name.className = 'lyric-size-option-name';
      name.textContent = labels[index] || `${scale}x`;
      // 预览字号：与按钮上的 A 同步缩放
      name.style.fontSize = this.#previewFontSize(scale);

      const value = document.createElement('span');
      value.className = 'lyric-size-option-value';
      value.textContent = `${scale}x`;

      option.append(name, value);
      this.lyricSizePanel.appendChild(option);

      on(option, 'click', () => {
        this.#setLyricScale(scale);
        this.#toggleLyricSizePanel(false);
      }, { signal });
    });
  }

  /** 切换字号面板显示 */
  #toggleLyricSizePanel(force) {
    if (!this.lyricSizePanel || !this.lyricSizeBtn) return;
    const show = typeof force === 'boolean' ? force : this.lyricSizePanel.hidden;
    this.lyricSizePanel.hidden = !show;
    this.lyricSizeBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) this.#syncLyricSizeOptions();
  }

  /** 面板打开时同步当前档位的高亮 */
  #syncLyricSizeOptions() {
    if (!this.lyricSizePanel) return;
    const current = Number(this.state.lyricScale) || 1;
    this.lyricSizePanel.querySelectorAll('.lyric-size-option').forEach((option) => {
      const active = Number(option.dataset.scale) === current;
      option.classList.toggle('active', active);
      option.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  #setLyricScale(scale) {
    if (!Number.isFinite(scale)) return;
    this.state.lyricScale = scale;
    setStorage(this.config.STORAGE_KEYS.LYRIC_SCALE, scale);
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
