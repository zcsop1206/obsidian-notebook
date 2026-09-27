// A searchable list of the built-in page templates, for "Add page with template…" and the
// "Change template" commands. #10's toolbar will offer the same choices.
import { FuzzySuggestModal, type App } from 'obsidian';
import { BUILT_IN_TEMPLATES, parseTemplate, type BuiltInTemplate, type Template } from '../format/template';

export class TemplateChooser extends FuzzySuggestModal<BuiltInTemplate> {
  constructor(app: App, placeholder: string, private onChoose: (template: Template) => void) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getItems(): BuiltInTemplate[] {
    return [...BUILT_IN_TEMPLATES];
  }

  getItemText(item: BuiltInTemplate): string {
    return item.label;
  }

  onChooseItem(item: BuiltInTemplate) {
    this.onChoose(parseTemplate(item.template));
  }
}
