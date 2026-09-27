import { Plugin } from 'obsidian';
import { Recorder } from './debug/recorder';
import { DebugView, VIEW_TYPE_DEBUG } from './debug/view';
import { LOG_PREFIX } from './debug/util';

/**
 * Notebook spike: measures Apple Pencil input and audio recording inside Obsidian on the iPad.
 */
export default class NotebookSpike extends Plugin {
  recorder!: Recorder;

  async onload() {
    this.recorder = new Recorder(this);
    this.registerView(VIEW_TYPE_DEBUG, leaf => new DebugView(leaf, this));
    this.addRibbonIcon('pencil', 'Notebook spike', () => this.open());
    this.addCommand({ id: 'open', name: 'Open pen and audio test', callback: () => this.open() });
    this.addCommand({ id: 'toggle-recording', name: 'Start or stop test recording', callback: () => this.recorder.toggle() });
    this.app.workspace.onLayoutReady(() => {
      this.recorder.recover().catch(e => console.error(LOG_PREFIX, 'recover', e));
    });
  }

  onunload() {
    this.recorder.stop();
  }

  async open() {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW_TYPE_DEBUG)[0];
    if (!leaf) {
      leaf = ws.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE_DEBUG, active: true });
    }
    ws.revealLeaf(leaf);
  }
}
