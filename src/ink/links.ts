// Obsidian's own link update after a rename (#62). When a file or folder is renamed from the
// file explorer, Obsidian collects every link first, renames, then (after asking, unless
// "Automatically update internal links" is on) replaces the links that no longer resolve to the
// same path, at the offsets they had before the rename. A note index rewritten in between would
// be garbled, so the plugin's own index writes after a rename wait for that update to finish.
import type { App } from 'obsidian';

/**
 * Resolves when Obsidian has finished updating links for the renames under way (at once if none
 * is). Obsidian runs each update on a queue (`fileManager.updateQueue`, not in the public API);
 * a task queued behind it runs when the update, with its dialog, is done.
 */
export function linkUpdatesDone(app: App): Promise<void> {
  const queue = (app.fileManager as unknown as { updateQueue?: { queue?: (task: () => void) => unknown } } | undefined)?.updateQueue;
  if (!queue || typeof queue.queue !== 'function') return Promise.resolve();
  try {
    return Promise.resolve(queue.queue(() => {})).then(() => undefined, () => undefined);
  } catch (e) {
    return Promise.resolve();
  }
}
