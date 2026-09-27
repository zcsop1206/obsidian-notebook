// Plugin settings: the paper size and template of new ink notes, and the ink toolbar's tools and
// favourite presets (#10), the templates folder (#21) and the favourite templates (#54).
import { PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';
import type { Paper } from './format/page';
import { BUILT_IN_TEMPLATES, isTemplateName } from './format/template';
import { isFavourite, parseFavourites, toggleFavourite } from './ink/favourites';
import { DEFAULT_PRESETS, DEFAULT_TOOL_STATE, parsePresets, parseToolState, type PenPreset, type ToolState } from './ink/pen';
import { canonicalName, isCustomName, templateRegistry } from './ink/templates';

export interface NotebookSettings {
  /** Paper size of new ink notes. */
  paper: Paper;
  /**
   * Template name of new ink notes: a built-in (e.g. `lined-college`, see BUILT_IN_TEMPLATES) or
   * a custom template's `tpl:<name>` (#54). The first favourite wins when `favouriteDefault` is on.
   */
  template: string;
  /** The tool in use and each tool's settings, restored when an ink view opens (#10). */
  tools: ToolState;
  /** The favourite presets: MAX_PRESETS slots at most, null for an empty one (#10). */
  presets: (PenPreset | null)[];
  /** Vault folder of custom templates (#21, #54). */
  templatesFolder: string;
  /** Starred template names, built-in or `tpl:<name>`, in the order starred (#54). */
  favouriteTemplates: string[];
  /** Whether new notes start with the first favourite template (else `template`) (#54). */
  favouriteDefault: boolean;
}

export const DEFAULT_SETTINGS: NotebookSettings = {
  paper: 'letter', template: 'blank', tools: DEFAULT_TOOL_STATE, presets: [...DEFAULT_PRESETS], templatesFolder: 'templates/ink',
  favouriteTemplates: [], favouriteDefault: true,
};

/** Settings from saved data, ignoring unknown or invalid values (with a warning for a template). */
export function parseSettings(data: unknown): NotebookSettings {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Partial<Record<keyof NotebookSettings, unknown>>;
  let template = DEFAULT_SETTINGS.template;
  if (typeof d.template === 'string' && (isTemplateName(d.template) || isCustomName(d.template))) template = canonicalName(d.template);
  else if (d.template !== undefined) console.warn('[notebook]', `Unknown template ${JSON.stringify(d.template)} in settings; using ${template}`);
  const templatesFolder = typeof d.templatesFolder === 'string' && d.templatesFolder.trim() ? d.templatesFolder.trim() : DEFAULT_SETTINGS.templatesFolder;
  return {
    paper: d.paper === 'a4' || d.paper === 'letter' ? d.paper : DEFAULT_SETTINGS.paper,
    template,
    tools: parseToolState(d.tools),
    presets: parsePresets(d.presets),
    templatesFolder,
    favouriteTemplates: parseFavourites(d.favouriteTemplates),
    favouriteDefault: typeof d.favouriteDefault === 'boolean' ? d.favouriteDefault : DEFAULT_SETTINGS.favouriteDefault,
  };
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
    const customs = templateRegistry()?.entries ?? [];
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
        for (const e of customs) d.addOption(e.name, `${e.label} (custom)`);
        d.setValue(this.plugin.settings.template).onChange(async value => {
          if (!isTemplateName(value) && !isCustomName(value)) return;
          this.plugin.settings.template = value;
          await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl)
      .setName('Start new notes with the first favourite')
      .setDesc('When on, new notes use the first starred template below, if any, instead of the default template.')
      .addToggle(t => t.setValue(this.plugin.settings.favouriteDefault).onChange(async on => {
        this.plugin.settings.favouriteDefault = on;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName('Templates folder')
      .setDesc('Where custom templates are saved: PDF pages, images and page backgrounds saved as templates.')
      .addText(t => t
        .setPlaceholder(DEFAULT_SETTINGS.templatesFolder)
        .setValue(this.plugin.settings.templatesFolder)
        .onChange(async value => {
          this.plugin.settings.templatesFolder = value.trim() || DEFAULT_SETTINGS.templatesFolder;
          await this.plugin.saveSettings();
        }));
    this.favourites(containerEl, customs);
  }

  /** Favourite templates (#54): a toggle per template; starred ones come first wherever templates are chosen. */
  private favourites(containerEl: HTMLElement, customs: readonly { name: string; label: string }[]) {
    const s = this.plugin.settings;
    new Setting(containerEl).setName('Favourite templates').setHeading();
    const order = new Setting(containerEl).setDesc('');
    const labels = new Map<string, string>([...BUILT_IN_TEMPLATES.map(t => [t.name, t.label] as const), ...customs.map(e => [e.name, e.label] as const)]);
    const showOrder = () => {
      const list = s.favouriteTemplates.map(n => labels.get(n) ?? n);
      order.descEl.setText(list.length ? `First in every template list, in this order: ${list.join(', ')}.` : 'None starred yet. Star templates here or in the template chooser.');
    };
    showOrder();
    for (const [name, label] of labels) {
      new Setting(containerEl).setName(label).setClass('nb-favourite-template').addToggle(t => t
        .setValue(isFavourite(s.favouriteTemplates, name))
        .onChange(async on => {
          if (on !== isFavourite(s.favouriteTemplates, name)) s.favouriteTemplates = toggleFavourite(s.favouriteTemplates, name);
          showOrder();
          await this.plugin.saveSettings();
        }));
    }
  }
}
