# obsidian-notebook

An Obsidian plugin for keeping an engineering notebook on the iPad: handwriting, audio recording and GitHub sync, stored as plain files in the vault.

Right now it is a throwaway spike that measures Apple Pencil input and audio recording inside Obsidian. It writes everything under `_spike/`.

## Install on the iPad

1. Install **BRAT** from Community plugins and enable it.
2. BRAT → Add beta plugin → `zcsop1206/obsidian-notebook`.
3. Enable **Notebook spike** under Community plugins.

## Release

Bump `version` in `manifest.json` and `versions.json`, commit, then push a tag with the same version. The workflow attaches `main.js`, `manifest.json` and `styles.css` to a GitHub release.
