/**
 * 课本 / 单元选择与课程列表
 * @module ui/UnitView
 */

import { on, qs, qsa, setHTML, toggleClass } from '../utils/dom.js';

function fillSelect(select, items, getValue, getLabel, selected) {
  if (!select) return;
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const option = document.createElement('option');
    option.value = getValue(item);
    option.textContent = getLabel(item);
    fragment.appendChild(option);
  }
  select.replaceChildren(fragment);
  if (selected !== undefined && selected !== null && selected !== '') {
    select.value = String(selected);
  }
}

export class UnitView {
  /**
   * @param {Object} options
   * @param {HTMLElement} [options.unitList]
   * @param {HTMLSelectElement} [options.unitSelect]
   * @param {HTMLSelectElement[]} [options.bookSelects]
   * @param {HTMLImageElement} [options.bookCover]
   * @param {HTMLElement} [options.bookTitle]
   * @param {HTMLElement} [options.bookHint]
   * @param {HTMLElement} [options.prevBtn]
   * @param {HTMLElement} [options.nextBtn]
   * @param {(index: number) => void} [options.onUnitChange]
   * @param {(bookKey: string) => void} [options.onBookChange]
   */
  constructor(options) {
    this.unitList = options.unitList;
    this.unitSelect = options.unitSelect;
    this.bookSelects = options.bookSelects || [];
    this.bookCover = options.bookCover;
    this.bookTitle = options.bookTitle;
    this.bookHint = options.bookHint;
    this.prevBtn = options.prevBtn;
    this.nextBtn = options.nextBtn;
    this.onUnitChange = options.onUnitChange;
    this.onBookChange = options.onBookChange;
    this.abort = new AbortController();
    this.#bind();
  }

  /**
   * @param {Array<{id?: string, key: string, title: string, bookPath: string}>} books
   * @param {string} selectedId
   */
  renderBooks(books, selectedId) {
    const valid = books.filter((book) => book?.key && book?.title && (book?.path || book?.bookPath || book?.custom));
    // value 必须用唯一 id：同一 key 可能有多个来源（本地 / 各个镜像站），
    // 用 key 会让选中的第二本在回填时被第一本顶掉
    this.bookSelects.forEach((select) => {
      fillSelect(select, valid, (book) => book.id || book.key, (book) => book.title, selectedId);
    });
  }

  /**
   * @param {Array<{title: string}>} units
   */
  renderUnits(units) {
    if (this.unitList) {
      const items = units.map((unit, index) => {
        const title = document.createElement('h3');
        title.textContent = unit.title;
        const item = document.createElement('div');
        item.className = 'unit-item';
        item.dataset.unitIndex = String(index);
        item.tabIndex = 0;
        item.setAttribute('role', 'button');
        item.setAttribute('aria-label', `打开 ${unit.title}`);
        item.appendChild(title);
        return item;
      });
      this.unitList.replaceChildren(...items);
    }

    fillSelect(
      this.unitSelect,
      units.map((unit, index) => ({ unit, index })),
      (item) => String(item.index),
      (item) => item.unit.title,
    );
  }

  /**
   * @param {string} coverUrl
   */
  setCover(coverUrl) {
    if (!this.bookCover) return;
    if (coverUrl) {
      this.bookCover.src = coverUrl;
    } else {
      this.bookCover.removeAttribute('src');
    }
  }

  /**
   * @param {{title?: string, key?: string, bookName?: string, bookLevel?: string}|null} book
   */
  setBookMeta(book) {
    if (this.bookTitle) {
      this.bookTitle.textContent = book?.bookName || book?.title || '选择课本';
    }
    if (this.bookHint) {
      this.bookHint.textContent = book?.bookLevel || book?.key || '';
    }
  }

  /**
   * @param {number} unitIndex
   * @param {{scroll?: boolean}} [options]
   */
  setActive(unitIndex, options = {}) {
    if (this.unitList) {
      qsa('.unit-item', this.unitList).forEach((item, index) => {
        toggleClass(item, 'active', index === unitIndex);
      });
      if (options.scroll) {
        const active = qs(`.unit-item[data-unit-index="${unitIndex}"]`, this.unitList);
        active?.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
    }

    if (this.unitSelect && unitIndex >= 0) {
      this.unitSelect.value = String(unitIndex);
    }
  }

  /**
   * @param {number} currentIndex
   * @param {number} total
   */
  updateNav(currentIndex, total) {
    if (this.prevBtn) this.prevBtn.disabled = currentIndex <= 0;
    if (this.nextBtn) this.nextBtn.disabled = currentIndex >= total - 1;
  }

  resetListScroll() {
    const scroller = this.unitList?.closest('.unit-list');
    if (scroller) scroller.scrollTop = 0;
  }

  clearUnits() {
    if (this.unitList) setHTML(this.unitList, '');
    if (this.unitSelect) setHTML(this.unitSelect, '<option value="">选择 Unit</option>');
    this.resetListScroll();
  }

  destroy() {
    this.abort.abort();
  }

  #bind() {
    const signal = this.abort.signal;

    const pickUnit = (event) => {
      const item = event.target.closest('.unit-item');
      if (!item) return;
      const index = parseInt(item.dataset.unitIndex, 10);
      if (Number.isFinite(index)) this.onUnitChange?.(index);
    };

    if (this.unitList) {
      on(this.unitList, 'click', pickUnit, { signal });
      on(this.unitList, 'keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        pickUnit(event);
      }, { signal });
    }

    if (this.unitSelect) {
      on(this.unitSelect, 'change', (event) => {
        const index = parseInt(event.target.value, 10);
        if (index >= 0) this.onUnitChange?.(index);
      }, { signal });
    }

    this.bookSelects.forEach((select) => {
      on(select, 'change', (event) => {
        if (event.target.value) this.onBookChange?.(event.target.value);
      }, { signal });
    });

    if (this.prevBtn) {
      on(this.prevBtn, 'click', () => this.#navigate('prev'), { signal });
    }
    if (this.nextBtn) {
      on(this.nextBtn, 'click', () => this.#navigate('next'), { signal });
    }

    // PageUp / PageDown 切换上一课 / 下一课，与两个导航按钮走同一条路径
    // （含 disabled 判断），行为完全一致
    const PAGE_KEYS = { PageUp: 'prev', PageDown: 'next' };
    on(document, 'keydown', (event) => {
      const direction = PAGE_KEYS[event.key];
      if (!direction) return;
      // 带修饰键的组合留给浏览器（Ctrl+PageUp 切标签页等）
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      // 焦点在表单控件里时不拦截：输入框要能正常移动光标，
      // select 上的方向/翻页键有原生语义且会自行触发 change
      const target = event.target;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      if (this.#navigate(direction)) event.preventDefault();
    }, { signal });
  }

  /**
   * 触发上一课 / 下一课；按钮处于 disabled（已是首课 / 末课）时什么都不做
   * @param {'prev'|'next'} direction
   * @returns {boolean} 是否真的触发了切换
   */
  #navigate(direction) {
    const btn = direction === 'prev' ? this.prevBtn : this.nextBtn;
    if (!btn || btn.disabled) return false;
    this.onUnitChange?.(direction);
    return true;
  }
}
