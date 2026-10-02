// "Go to page" (#64): the page indicator in the toolbar ("37 / 812") opens a small dialog with
// a number field; Enter goes to that page. Numbers past either end go to the first or last page.
import { Modal, type App } from 'obsidian';
import { parsePageNumber } from './page-number';

export { pageLabel, parsePageNumber } from './page-number';

/** Asks for a page number, starting from the current page, and calls `go` with the 0-based page. */
export class GoToPageModal extends Modal {
  constructor(app: App, private current: number, private total: number, private go: (index: number) => void) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText('Go to page');
    this.modalEl.addClass('nb-goto-modal');
    const row = this.contentEl.createDiv({ cls: 'nb-goto-row' });
    const input = row.createEl('input', {
      cls: 'nb-goto-input',
      attr: { type: 'number', inputmode: 'numeric', min: '1', max: String(this.total), step: '1', 'aria-label': 'Page number' },
    });
    input.value = String(this.current + 1);
    row.createSpan({ cls: 'nb-goto-total', text: `of ${this.total}` });
    const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const ok = buttons.createEl('button', { text: 'Go', cls: 'mod-cta' });
    const submit = () => {
      const index = parsePageNumber(input.value, this.total);
      if (index === null) {
        input.focus();
        return;
      }
      this.close();
      this.go(index);
    };
    ok.addEventListener('click', submit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}
