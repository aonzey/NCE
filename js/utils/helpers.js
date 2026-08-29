/**
 * 通用工具
 * @module utils/helpers
 */

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function throttle(func, wait = 300) {
  let lastCall = 0;
  function throttled(...args) {
    const now = Date.now();
    if (now - lastCall >= wait) {
      lastCall = now;
      return func.apply(this, args);
    }
    return undefined;
  }
  // 重置计时窗口；用于切换资源前丢弃旧的节流状态
  throttled.cancel = () => {
    lastCall = 0;
  };
  return throttled;
}

export function debounce(func, wait = 300) {
  let timeoutId;
  function debounced(...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      timeoutId = null;
      func.apply(this, args);
    }, wait);
  }
  debounced.cancel = () => {
    clearTimeout(timeoutId);
    timeoutId = null;
  };
  return debounced;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
