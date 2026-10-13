/**
 * 全屏字幕视图
 *
 * 全屏居中显示「上一句 / 当前句 / 下一句」，底部浮一层播放控件与字号滑块，
 * 鼠标静止 3 秒后控件与滑块自动淡出（移动鼠标或按键即恢复）。
 *
 * 优先用原生 Fullscreen API（能真正隐藏浏览器界面）；浏览器不支持或拒绝了
 * 就退回 CSS 铺满视口的浮层，功能完全一致。
 * @module ui/FullscreenLyric
 */

import { CONFIG } from '../config.js';
import { on, setText, toggleClass } from '../utils/dom.js';
import { clamp, formatTime } from '../utils/helpers.js';

/** 只显示英文 / 只显示中文 / 模糊中文 对应的类名 */
const MODE_CLASS = {
  english: 'fs-only-en',
  chinese: 'fs-only-zh',
  blur: 'fs-blur-zh',
};

export class FullscreenLyric {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.root 全屏浮层根节点
   * @param {() => void} [options.onTogglePlay]
   * @param {(ratio: number) => void} [options.onSeekRatio] 进度条点击/拖动，0~1
   * @param {() => void} [options.onPrevSentence]
   * @param {() => void} [options.onNextSentence]
   * @param {() => void} [options.onCycleSpeed]
   * @param {(scale: number) => void} [options.onScaleChange]
   * @param {number} [options.idleMs]
   */
  constructor(options) {
    this.root = options.root;
    this.onTogglePlay = options.onTogglePlay;
    this.onSeekRatio = options.onSeekRatio;
    this.onPrevSentence = options.onPrevSentence;
    this.onNextSentence = options.onNextSentence;
    this.onCycleSpeed = options.onCycleSpeed;
    this.onScaleChange = options.onScaleChange;
    this.idleMs = options.idleMs ?? CONFIG.UI.FULLSCREEN_IDLE_MS;

    this.prevEl = this.root?.querySelector('#fsLyricPrev');
    this.enEl = this.root?.querySelector('#fsLyricEn');
    this.zhEl = this.root?.querySelector('#fsLyricZh');
    this.nextEl = this.root?.querySelector('#fsLyricNext');
    this.controlsEl = this.root?.querySelector('#fsControls');
    this.playBtn = this.root?.querySelector('#fsPlayBtn');
    this.prevBtn = this.root?.querySelector('#fsPrevBtn');
    this.nextBtn = this.root?.querySelector('#fsNextBtn');
    this.speedBtn = this.root?.querySelector('#fsSpeedBtn');
    this.exitBtn = this.root?.querySelector('#fsExitBtn');
    this.progressBar = this.root?.querySelector('#fsProgressBar');
    this.currentTimeEl = this.root?.querySelector('#fsCurrentTime');
    this.durationEl = this.root?.querySelector('#fsDuration');
    this.slider = this.root?.querySelector('#fsSizeSlider');
    this.sizeValueEl = this.root?.querySelector('#fsSizeValue');

    this.lyrics = [];
    this.activeIndex = -1;
    this.translationMode = 'show';
    this.scale = CONFIG.FULLSCREEN_LYRIC.DEFAULT_SCALE;
    this.isOpen = false;
    this.dragging = false;
    this.idleTimer = 0;
    this.abort = new AbortController();

    if (this.slider) {
      const { MIN_SCALE, MAX_SCALE, STEP } = CONFIG.FULLSCREEN_LYRIC;
      this.slider.min = String(MIN_SCALE);
      this.slider.max = String(MAX_SCALE);
      this.slider.step = String(STEP);
    }

    this.#bind();
  }

  /** 打开全屏字幕 */
  open() {
    if (!this.root || this.isOpen) return;
    this.isOpen = true;
    this.root.hidden = false;
    this.root.setAttribute('aria-hidden', 'false');
    this.#render();
    this.#wake();
    this.#requestNativeFullscreen();
  }

  /** 关闭（会同时退出原生全屏） */
  close() {
    if (!this.root || !this.isOpen) return;
    this.isOpen = false;
    this.#stopIdleTimer();
    toggleClass(this.root, 'idle', false);
    this.root.hidden = true;
    this.root.setAttribute('aria-hidden', 'true');
    this.#exitNativeFullscreen();
  }

  /** 当前是否处于原生全屏 */
  get isNativeFullscreen() {
    const el = document.fullscreenElement || document.webkitFullscreenElement;
    return Boolean(el) && el === this.root;
  }

  /**
   * @param {Array<{time: number, english: string, chinese?: string}>} lyrics
   */
  setLyrics(lyrics) {
    this.lyrics = Array.isArray(lyrics) ? lyrics : [];
    // 换了课本/课程，旧的高亮下标已经失效
    this.activeIndex = -1;
    this.#render();
  }

  /** @param {number} index */
  setActive(index) {
    if (index === this.activeIndex) return;
    this.activeIndex = index;
    this.#render();
  }

  /** @param {string} mode show / english / chinese / blur */
  setTranslationMode(mode) {
    this.translationMode = mode;
    if (this.root) {
      Object.values(MODE_CLASS).forEach((cls) => this.root.classList.remove(cls));
      const cls = MODE_CLASS[mode];
      if (cls) this.root.classList.add(cls);
    }
    this.#render();
  }

  /** @param {number} scale */
  setScale(scale) {
    if (!Number.isFinite(scale)) return;
    const { MIN_SCALE, MAX_SCALE } = CONFIG.FULLSCREEN_LYRIC;
    this.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
    this.root?.style.setProperty('--fs-scale', String(this.scale));
    if (this.slider && Number(this.slider.value) !== this.scale) {
      this.slider.value = String(this.scale);
    }
    setText(this.sizeValueEl, `${this.scale.toFixed(1)}x`);
  }

  /** @param {boolean} playing */
  setPlaying(playing) {
    toggleClass(this.playBtn, 'playing', Boolean(playing));
    this.playBtn?.setAttribute('aria-label', playing ? '暂停' : '播放');
  }

  /** @param {string} text 形如 1.5x */
  setSpeedLabel(text) {
    setText(this.speedBtn, text);
  }

  /**
   * @param {number} current
   * @param {number} duration
   */
  updateProgress(current, duration) {
    const total = Number.isFinite(duration) && duration > 0 ? duration : 0;
    const value = Number.isFinite(current) ? Math.max(0, current) : 0;
    const percent = total > 0 ? clamp((value / total) * 100, 0, 100) : 0;
    this.progressBar?.style.setProperty('--fs-progress', `${percent}%`);
    setText(this.currentTimeEl, formatTime(value));
    setText(this.durationEl, formatTime(total));
  }

  /** 销毁：解绑所有监听 */
  destroy() {
    this.#stopIdleTimer();
    this.abort.abort();
  }

  #bind() {
    if (!this.root) return;
    const { signal } = this.abort;

    on(this.exitBtn, 'click', () => this.close(), { signal });
    on(this.playBtn, 'click', () => this.onTogglePlay?.(), { signal });
    on(this.prevBtn, 'click', () => this.onPrevSentence?.(), { signal });
    on(this.nextBtn, 'click', () => this.onNextSentence?.(), { signal });
    on(this.speedBtn, 'click', () => this.onCycleSpeed?.(), { signal });

    on(this.slider, 'input', () => {
      const scale = parseFloat(this.slider.value);
      this.setScale(scale);
      this.onScaleChange?.(this.scale);
    }, { signal });
    // 拖动滑块时不要因为鼠标不动而被隐藏
    on(this.slider, 'pointerdown', () => this.#wake(), { signal });

    this.#bindProgressBar(signal);
    this.#bindIdle(signal);

    // 兜底：原生全屏被 ESC 退出时同步关闭浮层
    on(document, 'fullscreenchange', () => {
      if (this.isOpen && !this.isNativeFullscreen) this.close();
    }, { signal });
    on(document, 'webkitfullscreenchange', () => {
      if (this.isOpen && !this.isNativeFullscreen) this.close();
    }, { signal });

    // 原生全屏不可用时（或用户主动按 ESC）用键盘关闭
    on(document, 'keydown', (event) => {
      if (!this.isOpen) return;
      if (event.key === 'Escape' && !this.isNativeFullscreen) this.close();
    }, { signal });
  }

  #bindProgressBar(signal) {
    if (!this.progressBar) return;

    const ratioOf = (clientX) => {
      const rect = this.progressBar.getBoundingClientRect();
      return rect.width > 0 ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0;
    };

    on(this.progressBar, 'pointerdown', (event) => {
      this.dragging = true;
      toggleClass(this.progressBar, 'dragging', true);
      this.progressBar.setPointerCapture?.(event.pointerId);
      this.onSeekRatio?.(ratioOf(event.clientX));
    }, { signal, passive: true });

    on(this.progressBar, 'pointermove', (event) => {
      if (!this.dragging) return;
      this.onSeekRatio?.(ratioOf(event.clientX));
    }, { signal, passive: true });

    const endDrag = (event) => {
      if (!this.dragging) return;
      this.dragging = false;
      toggleClass(this.progressBar, 'dragging', false);
      if (event?.pointerId != null) {
        try {
          this.progressBar.releasePointerCapture(event.pointerId);
        } catch {
          // 已经释放过
        }
      }
    };

    on(this.progressBar, 'pointerup', endDrag, { signal, passive: true });
    on(this.progressBar, 'pointercancel', endDrag, { signal, passive: true });
  }

  /** 鼠标静止 idleMs 后隐藏控件；任何交互都重新唤醒 */
  #bindIdle(signal) {
    const wake = () => {
      if (this.isOpen) this.#wake();
    };
    ['pointermove', 'pointerdown', 'wheel', 'touchstart', 'click', 'keydown'].forEach((type) => {
      on(this.root, type, wake, { signal, passive: true });
    });
    // 鼠标移出浮层（例如移到浏览器工具栏）时立刻隐藏，避免控件卡在屏幕上
    on(this.root, 'pointerleave', () => {
      if (this.isOpen) this.#sleep();
    }, { signal });
  }

  #wake() {
    toggleClass(this.root, 'idle', false);
    this.#stopIdleTimer();
    this.idleTimer = setTimeout(() => this.#sleep(), this.idleMs);
  }

  #sleep() {
    this.#stopIdleTimer();
    toggleClass(this.root, 'idle', true);
  }

  #stopIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = 0;
    }
  }

  #render() {
    if (!this.root || !this.isOpen) return;

    // 还没开始播放时没有高亮句，此时显示第一句，避免打开就是一片空白；
    // 下标越界（例如刚切课本）也退回第一句
    const raw = this.activeIndex >= 0 ? this.activeIndex : 0;
    const index = raw >= 0 && raw < this.lyrics.length ? raw : -1;
    const current = index >= 0 ? this.lyrics[index] : null;
    const prev = index > 0 ? this.lyrics[index - 1] : null;
    const next = index >= 0 ? this.lyrics[index + 1] : null;

    setText(this.prevEl, prev?.english || '');
    setText(this.enEl, current?.english || '');
    setText(this.zhEl, current?.chinese || '');
    setText(this.nextEl, next?.english || '');

    // 没有中文时隐藏那一行，避免出现空行占位
    toggleClass(this.zhEl, 'empty', !current?.chinese);
  }

  #requestNativeFullscreen() {
    const el = this.root;
    const request = el?.requestFullscreen || el?.webkitRequestFullscreen;
    if (!request) return; // 不支持就用 CSS 铺满视口兜底
    try {
      // 可能被浏览器策略拒绝（例如非用户手势触发），失败时静默退回浮层
      Promise.resolve(request.call(el)).catch(() => {});
    } catch {
      // 忽略
    }
  }

  #exitNativeFullscreen() {
    if (!this.isNativeFullscreen) return;
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    try {
      Promise.resolve(exit?.call(document)).catch(() => {});
    } catch {
      // 忽略
    }
  }
}
