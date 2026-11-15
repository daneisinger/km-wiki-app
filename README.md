# km-wiki-app

Public facing front end for private knowledge management tool.

A static web app, served by GitHub Pages. It holds no notes and no secrets: it reads and writes a private wiki repo through GitHub's API from your browser, using an access token you enter once per browser and that stays in that browser.

## Using it

Open the Pages address for this repo. The first screen asks for the GitHub user, the wiki repository, its branch and a fine-grained access token limited to that repository with Contents set to Read and write.

## Where the code comes from

These files are a copy of the `app/` folder in the private wiki repo, which is where changes are made. Do not edit them here; they are replaced when the copy is refreshed.

Copied from commit `4575664`.

## Files

| File | Purpose |
|---|---|
| `index.html`, `app.css`, `manifest.webmanifest`, `icon-*.png` | Shell and styling. |
| `app.js` | Screens and rendering. |
| `core.js` | GitHub access and the wiki's file formats. |
| `vendor/marked.esm.js` | Markdown renderer (marked 12.0.2, MIT). |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are. |
