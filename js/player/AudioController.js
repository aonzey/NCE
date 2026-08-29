/**
 * HTMLAudioElement 封装：播放、进度条、倍速、时长恢复
 * @module player/AudioController
 */

import { addClass, on, removeClass, setText, toggleClass } from '../utils/dom.js';
import { clamp, formatTime } from '../utils/helpers.js';

export class AudioController {
  /**
   * @param {Object} options
   * @param {HTMLAudioElement} options.audio
   * @param {HTMLElement} [options.playBtn]
   * @param {HTMLElement} [options.progressBar]
   * @param {HTMLElement} [options.currentTimeEl]
   * @param {HTMLElement} [options.durationEl]
   * @param {(currentTime: number, duration: number) => void} [options.onTick]
   * @param {(currentTime: number) => void} [options.onPersist]
   * @param {() => void} [options.onEnded]
   * @param {() => void} [options.onLoaded] 音频加载完成（元数据就绪）后触发
   * @param {() => void} [options.onUserPause] 用户通过播放按钮手动暂停时触发
   */
  constructor(options) {
    this.audio = options.audio;
    this.playBtn = options.playBtn;
    this.progressBar = options.progressBar;
    this.currentTimeEl = options.currentTimeEl;
    this.durationEl = options.durationEl;
    this.onTick = options.onTick;
    this.onPersist = options.onPersist;
    this.onEnded = options.onEnded;
    this.onLoaded = options.onLoaded;
    this.onUserPause = options.onUserPause;

    this.dragging = false;
    this.pendingTime = 0;
    this.rafId = 0;
    this.abort = new AbortController();

    this.#bind();
  }

  get currentTime() {
    return this.audio?.currentTime ?? 0;
  }

  get duration() {
    return this.audio?.duration ?? 0;
  }

  get paused() {
    return this.audio?.paused ?? true;
  }

  get playbackRate() {
    return this.audio?.playbackRate ?? 1;
  }

  /**
   * @param {string} url
   * @param {{loop?: boolean, playbackRate?: number, startTime?: number}} [options]
   */
  setSrc(url, options = {}) {
    if (!this.audio) return;

    this.audio.pause();
    this.audio.src = url;
    this.audio.loop = Boolean(options.loop);
    const rate = Number.isFinite(options.playbackRate) ? options.playbackRate : 1;
    // load() 会把 playbackRate 重置为 defaultPlaybackRate，两者必须同步维护
    this.audio.defaultPlaybackRate = rate;
    this.audio.playbackRate = rate;
    this.pendingTime = Number.isFinite(options.startTime) ? options.startTime : 0;
    this.setDisabled(true);
    this.setProgress(0);
    this.audio.load();
  }

  setLoop(enabled) {
    if (this.audio) this.audio.loop = Boolean(enabled);
  }

  setRate(rate) {
    if (this.audio && Number.isFinite(rate)) {
      this.audio.defaultPlaybackRate = rate;
      this.audio.playbackRate = rate;
    }
  }

  async play() {
    if (!this.audio) return;
    try {
      await this.audio.play();
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.warn('Audio play failed:', error);
      }
    }
  }

  pause() {
    this.audio?.pause();
  }

  toggle() {
    if (this.paused) {
      this.play();
    } else {
      this.pause();
    }
  }

  seek(time) {
    if (!this.audio || !Number.isFinite(time)) return;
    const duration = this.duration;
    const max = Number.isFinite(duration) && duration > 0 ? duration : time;
    this.audio.currentTime = clamp(time, 0, max);
    this.updateProgress(true);
  }

  reset() {
    if (!this.audio) return;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.pendingTime = 0;
    this.setProgress(0);
    this.setDisabled(true);
    this.updatePlayButton();
    setText(this.currentTimeEl, '0:00');
    setText(this.durationEl, '0:00');
  }

  setDisabled(disabled) {
    if (!this.playBtn) return;
    this.playBtn.disabled = disabled;
    this.playBtn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }

  updatePlayButton() {
    if (!this.playBtn) return;
    const playing = !this.paused;
    toggleClass(this.playBtn, 'playing', playing);
    this.playBtn.setAttribute('aria-label', playing ? '暂停' : '播放');
  }

  updateProgress(force = false) {
    if (!this.audio || (this.dragging && !force)) return;
    const duration = this.duration;
    const current = this.currentTime;
    const percent = duration > 0 ? (current / duration) * 100 : 0;
    this.setProgress(percent);
    setText(this.currentTimeEl, formatTime(current));
  }

  setProgress(percent) {
    this.progressBar?.style.setProperty('--progress', `${percent}%`);
  }

  destroy() {
    this.#stopTicker();
    this.abort.abort();
    this.reset();
  }

  /**
   * 逐帧驱动进度回调。
   * timeupdate 只有约 4Hz，高倍速时两次回调之间的音频推进会被放大 N 倍
   * （2x 约 500ms、3x 约 750ms），单句循环会越过句尾、漏出下一句开头。
   * 改用 rAF（约 60fps）把误差压到 16ms 量级。
   */
  #startTicker() {
    if (this.rafId) return;
    const loop = () => {
      this.rafId = requestAnimationFrame(loop);
      if (this.paused) {
        this.#stopTicker();
        return;
      }
      this.updateProgress();
      this.onTick?.(this.currentTime, this.duration);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  #stopTicker() {
    if (!this.rafId) return;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  #bind() {
    const signal = this.abort.signal;

    if (this.playBtn) {
      on(this.playBtn, 'click', () => {
        if (!this.paused) this.onUserPause?.();
        this.toggle();
      }, { signal });
    }

    if (this.progressBar) {
      const seekByClientX = (clientX) => {
        if (!this.audio || !this.duration) return;
        const rect = this.progressBar.getBoundingClientRect();
        const percent = clamp((clientX - rect.left) / rect.width, 0, 1);
        this.seek(percent * this.duration);
      };

      on(this.progressBar, 'click', (event) => seekByClientX(event.clientX), { signal });

      on(this.progressBar, 'pointerdown', (event) => {
        this.dragging = true;
        addClass(this.progressBar, 'dragging');
        this.progressBar.setPointerCapture(event.pointerId);
        seekByClientX(event.clientX);
      }, { signal, passive: true });

      on(this.progressBar, 'pointermove', (event) => {
        if (!this.dragging) return;
        seekByClientX(event.clientX);
      }, { signal, passive: true });

      const endDrag = (event) => {
        if (!this.dragging) return;
        this.dragging = false;
        removeClass(this.progressBar, 'dragging');
        if (event?.pointerId != null) {
          try {
            this.progressBar.releasePointerCapture(event.pointerId);
          } catch {
            // already released
          }
        }
        this.onPersist?.(this.currentTime);
      };

      on(this.progressBar, 'pointerup', endDrag, { signal, passive: true });
      on(this.progressBar, 'pointercancel', endDrag, { signal, passive: true });
    }

    if (!this.audio) return;

    const tick = () => {
      this.updateProgress();
      this.onTick?.(this.currentTime, this.duration);
    };

    // 兜底：后台标签页 rAF 会被冻结，此时仍靠 timeupdate 维持基本同步
    on(this.audio, 'timeupdate', tick, { signal });
    on(this.audio, 'loadedmetadata', () => {
      // 兜底：部分浏览器在加载新资源后仍可能将速率归 1
      this.audio.playbackRate = this.audio.defaultPlaybackRate;
      this.#applyPendingTime();
      this.setDisabled(false);
      this.onLoaded?.();
    }, { signal });
    on(this.audio, 'canplay', () => this.setDisabled(false), { signal });
    on(this.audio, 'loadstart', () => this.setDisabled(true), { signal });
    on(this.audio, 'play', () => {
      this.updatePlayButton();
      this.#startTicker();
    }, { signal });
    on(this.audio, 'pause', () => {
      this.updatePlayButton();
      this.#stopTicker();
      tick();
      this.onPersist?.(this.currentTime);
    }, { signal });
    on(this.audio, 'ended', () => {
      this.updatePlayButton();
      this.#stopTicker();
      tick();
      this.onEnded?.();
    }, { signal });
    on(this.audio, 'error', () => this.setDisabled(true), { signal });

    if (!this.paused) this.#startTicker();
  }

  #applyPendingTime() {
    setText(this.durationEl, formatTime(this.duration));

    if (this.pendingTime > 0 && this.duration > 0) {
      const target = Math.min(this.pendingTime, Math.max(0, this.duration - 0.05));
      if (Number.isFinite(target)) {
        this.audio.currentTime = target;
      }
      this.pendingTime = 0;
    }

    this.updateProgress();
  }
}
