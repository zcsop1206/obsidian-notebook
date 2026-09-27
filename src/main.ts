import { Plugin } from 'obsidian';
import { Recorder } from './debug/recorder';
import { DebugView, VIEW_TYPE_DEBUG } from './debug/view';
import { LOG_PREFIX } from './debug/util';

/**
 * Notebook: handwritten notes with the Apple Pencil, stored as SVG pages in the vault.
 * For now it holds the spike's measurements as an ink debug view and a test recorder.
 */
export default class NotebookPlugin extends Plugin {
  recorder!: Recorder;

  async onload() {
    this.recorder = new Recorder(this);
    this.registerView(VIEW_TYPE_DEBUG, leaf => new DebugView(leaf, this));
    this.addCommand({ id: 'open-debug-view', name: 'Open ink debug view', callback: () => this.openDebugView() });
    this.addCommand({ id: 'toggle-recording', name: 'Start or stop test recording', callback: () => this.recorder.toggle() });
    this.app.workspace.onLayoutReady(() => {
      this.recorder.recover().catch(e => console.error(LOG_PREFIX, 'recover', e));
    });
  }

  onunload() {
    this.recorder.stop();
  }

  async openDebugView() {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW_TYPE_DEBUG)[0];
    if (!leaf) {
      leaf = ws.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE_DEBUG, active: true });
    }
    ws.revealLeaf(leaf);
  }
}
