// Plugin settings: the paper size and template of new ink notes.
import { PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';
import type { Paper } from './format/page';
import { BUILT_IN_TEMPLATES, isTemplateName } from './format/template';

export interface NotebookSettings {
  /** Paper size of new ink notes. */
  paper: Paper;
  /** Template name (e.g. `lined-college`) of new ink notes; see BUILT_IN_TEMPLATES. */
  template: string;
}

export const DEFAULT_SETTINGS: NotebookSettings = { paper: 'letter', template: 'blank' };

/** Settings from saved data, ignoring unknown or invalid values (with a warning for a template). */
export function parseSettings(data: unknown): NotebookSettings {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Partial<Record<keyof NotebookSettings, unknown>>;
  let template = DEFAULT_SETTINGS.template;
  if (typeof d.template === 'string' && isTemplateName(d.template)) template = d.template;
  else if (d.template !== undefined) console.warn('[notebook]', `Unknown template ${JSON.stringify(d.template)} in settings; using ${template}`);
  return { paper: d.paper === 'a4' || d.paper === 'letter' ? d.paper : DEFAULT_SETTINGS.paper, template };
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
    new Setting(containerEl)
      .setName('Default template for new notes')
      .setDesc('The paper of new ink notes. Each note, and each page, can have its own.')
      .addDropdown(d => {
        for (const t of BUILT_IN_TEMPLATES) d.addOption(t.name, t.label);
        d.setValue(this.plugin.settings.template).onChange(async value => {
          if (!isTemplateName(value)) return;
          this.plugin.settings.template = value;
          await this.plugin.saveSettings();
        });
      });
  }
}
