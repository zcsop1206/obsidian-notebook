// Plugin settings. #19 adds the default template.
import { PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';
import type { Paper } from './format/page';

export interface NotebookSettings {
  /** Paper size of new ink notes. */
  paper: Paper;
}

export const DEFAULT_SETTINGS: NotebookSettings = { paper: 'letter' };

/** Settings from saved data, ignoring unknown or invalid values. */
export function parseSettings(data: unknown): NotebookSettings {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Partial<Record<keyof NotebookSettings, unknown>>;
  return { paper: d.paper === 'a4' || d.paper === 'letter' ? d.paper : DEFAULT_SETTINGS.paper };
}

interface SettingsHost extends Plugin {
  settings: NotebookSettings;
  saveSettings(): Promise<void>;
}

export class NotebookSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: SettingsHost) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName('Default paper size')
      .setDesc('For new ink notes. Existing notes keep their size.')
      .addDropdown(d => d
        .addOption('letter', 'Letter')
        .addOption('a4', 'A4')
        .setValue(this.plugin.settings.paper)
        .onChange(async value => {
          this.plugin.settings.paper = value === 'a4' ? 'a4' : 'letter';
          await this.plugin.saveSettings();
        }));
  }
}
