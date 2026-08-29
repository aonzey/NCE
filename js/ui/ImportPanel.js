/**
 * 导入面板 UI：触发按钮 + 四种导入方式（文件夹 / 多选文件 / ZIP / URL）
 * @module ui/ImportPanel
 */

import { on, toggleClass } from '../utils/dom.js';

export class ImportPanel {
  /**
   * @param {Object} options
   * @param {HTMLElement} [options.triggerBtn]
   * @param {HTMLElement} [options.panel]
   * @param {import('../services/ImportService.js').ImportService} options.importService
   * @param {(message: string, type?: string) => void} [options.toast]
   * @param {(book: {key: string, title: string}) => void} [options.onImported]
   * @param {(bookKey: string) => void} [options.onDeleted]
   */
  constructor(options) {
    this.importService = options.importService;
    this.toast = options.toast || (() => {});
    this.onImported = options.onImported;
    this.onDeleted = options.onDeleted;
    this.abort = new AbortController();
    this.busy = false;
    /** 等待二次确认的删除项复位函数，重渲染或关面板时统一清理 */
    this.pendingConfirms = [];

    this.triggerBtn = options.triggerBtn;
    this.panel = options.panel;
    this.folderInput = this.panel?.querySelector('#importFolderInput');
    this.filesInput = this.panel?.querySelector('#importFilesInput');
    this.zipInput = this.panel?.querySelector('#importZipInput');
    this.urlInput = this.panel?.querySelector('#importUrlInput');
    this.urlBtn = this.panel?.querySelector('#importUrlBtn');
    this.progressEl = this.panel?.querySelector('#importProgress');
    this.statusText = this.panel?.querySelector('.import-status-text');
    this.bookListEl = this.panel?.querySelector('#importBookList');
    this.nameInput = this.panel?.querySelector('#importNameInput');

    this.#bind();
    this.renderBookList();
  }

  toggle(force) {
    if (!this.panel) return;
    const show = typeof force === 'boolean' ? force : this.panel.hidden;
    this.#clearPendingConfirms();
    this.panel.hidden = !show;
    if (this.triggerBtn) this.triggerBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) this.renderBookList();
  }

  /** 取消所有待确认的删除，避免误删 */
  #clearPendingConfirms() {
    while (this.pendingConfirms.length) {
      this.pendingConfirms.pop()?.();
    }
  }

  #bind() {
    const { signal } = this.abort;

    if (this.triggerBtn) {
      on(this.triggerBtn, 'click', (event) => {
        event.stopPropagation();
        this.toggle();
      }, { signal });
    }

    this.panel?.querySelectorAll('[data-import]').forEach((btn) => {
      on(btn, 'click', () => {
        if (this.busy) return;
        const mode = btn.dataset.import;
        if (mode === 'folder') this.folderInput?.click();
        if (mode === 'files') this.filesInput?.click();
        if (mode === 'zip') this.zipInput?.click();
      }, { signal });
    });

    if (this.folderInput) {
      on(this.folderInput, 'change', (event) => this.#handleFiles(event, 'folder'), { signal });
    }
    if (this.filesInput) {
      on(this.filesInput, 'change', (event) => this.#handleFiles(event, 'files'), { signal });
    }
    if (this.zipInput) {
      on(this.zipInput, 'change', (event) => this.#handleZip(event), { signal });
    }
    if (this.urlBtn) {
      on(this.urlBtn, 'click', () => this.#handleUrl(), { signal });
    }
    if (this.urlInput) {
      on(this.urlInput, 'keydown', (event) => {
        if (event.key === 'Enter') this.#handleUrl();
      }, { signal });
    }

    // 点击面板外关闭
    on(document, 'click', (event) => {
      if (this.panel?.hidden) return;
      if (this.panel?.contains(event.target)) return;
      if (this.triggerBtn?.contains(event.target)) return;
      this.toggle(false);
    }, { signal });

    on(document, 'keydown', (event) => {
      if (event.key === 'Escape' && this.panel && !this.panel.hidden) this.toggle(false);
    }, { signal });

    on(window, 'pagehide', () => this.importService?.revokeBlobUrls(), { signal });
  }

  #setBusy(busy, text = '') {
    this.busy = busy;
    toggleClass(this.panel, 'importing', busy);
    if (this.statusText) this.statusText.textContent = text;
    if (this.progressEl) this.progressEl.hidden = !busy && !text;
  }

  #customTitle() {
    return (this.nameInput?.value || '').trim();
  }

  async #handleFiles(event, source) {
    const input = event.target;
    const files = input.files;
    if (!files?.length) return;
    this.#setBusy(true, '正在导入…');
    try {
      const book = await this.importService.importFromFileList(files, {
        title: this.#customTitle(),
        source,
      }, (done, total) => {
        this.#setBusy(true, `导入中 ${done}/${total}`);
      });
      this.#finish(book);
    } catch (error) {
      console.error('[import] 文件导入失败:', error);
      this.toast(`导入失败：${error.message || error}`, { type: 'error' });
      this.#setBusy(false);
    } finally {
      input.value = '';
    }
  }

  async #handleZip(event) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    this.#setBusy(true, '正在解压…');
    try {
      const buffer = await file.arrayBuffer();
      const book = await this.importService.importFromZip(buffer, {
        title: this.#customTitle(),
        zipName: file.name,
      }, (done, total) => {
        this.#setBusy(true, `导入中 ${done}/${total}`);
      });
      this.#finish(book);
    } catch (error) {
      console.error('[import] ZIP 导入失败:', error);
      this.toast(`导入失败：${error.message || error}`, { type: 'error' });
      this.#setBusy(false);
    } finally {
      input.value = '';
    }
  }

  async #handleUrl() {
    const url = (this.urlInput?.value || '').trim();
    if (!url) {
      this.toast('请输入 URL', { type: 'error' });
      return;
    }
    this.#setBusy(true, '正在获取…');
    try {
      const book = await this.importService.importFromUrl(url, {
        title: this.#customTitle(),
      }, (done, total) => {
        this.#setBusy(true, `获取歌词 ${done}/${total}`);
      });
      this.#finish(book);
    } catch (error) {
      console.error('[import] URL 导入失败:', error);
      this.toast(`导入失败：${error.message || error}`, { type: 'error' });
      this.#setBusy(false);
    }
  }

  #finish(book) {
    this.#setBusy(false, `已导入「${book.title}」（${book.unitCount} 课）`);
    this.toast(`已导入「${book.title}」（${book.unitCount} 课）`, { type: 'success' });
    this.renderBookList();
    if (this.nameInput) this.nameInput.value = '';
    if (this.urlInput) this.urlInput.value = '';
    this.onImported?.(book);
  }

  renderBookList() {
    if (!this.bookListEl) return;
    this.#clearPendingConfirms();
    const books = this.importService?.listBooks() || [];
    this.bookListEl.replaceChildren();
    if (!books.length) {
      const empty = document.createElement('p');
      empty.className = 'import-empty';
      empty.textContent = '暂无导入的课本';
      this.bookListEl.appendChild(empty);
      return;
    }
    for (const book of books) {
      const item = document.createElement('div');
      item.className = 'import-book-item';

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'import-book-label';
      label.title = '打开这本课本';
      label.textContent = `${book.title} · ${book.unitCount} 课`;

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'import-book-delete';
      del.title = '删除这本课本';
      del.setAttribute('aria-label', `删除 ${book.title}`);
      del.textContent = '✕';

      item.append(label, del);
      this.bookListEl.appendChild(item);

      const { signal } = this.abort;
      on(label, 'click', () => {
        if (!this.panel?.hidden) this.toggle(false);
        this.onImported?.(book);
      }, { signal });
      // 二次确认：首次点击变为「确认删除」，再点一次才执行，3.5 秒无操作自动复位
      let confirmTimer = null;
      const resetConfirm = () => {
        if (confirmTimer) {
          clearTimeout(confirmTimer);
          confirmTimer = null;
        }
        const idx = this.pendingConfirms.indexOf(resetConfirm);
        if (idx >= 0) this.pendingConfirms.splice(idx, 1);
        item.classList.remove('confirming');
        del.textContent = '✕';
        del.title = '删除这本课本';
      };

      on(del, 'click', async () => {
        if (this.busy) return;
        if (!item.classList.contains('confirming')) {
          this.#clearPendingConfirms();
          item.classList.add('confirming');
          del.textContent = '确认删除';
          del.title = `再次点击以删除「${book.title}」`;
          this.pendingConfirms.push(resetConfirm);
          confirmTimer = setTimeout(resetConfirm, 3500);
          return;
        }
        resetConfirm();
        await this.importService.deleteBook(book.key);
        this.toast(`已删除「${book.title}」`, { type: 'success' });
        this.renderBookList();
        this.onDeleted?.(book.key);
      }, { signal });
    }
  }

  destroy() {
    this.importService?.revokeBlobUrls();
    this.abort.abort();
  }
}
