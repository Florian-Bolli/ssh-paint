# SSH Paint

A lightweight PNG image editor for [Visual Studio Code](https://code.visualstudio.com), designed to work seamlessly over **Remote SSH**. Edit sprites, icons, and screenshots directly on your server — no need to copy files back and forth.

## Features

- **Pen tool** — freehand drawing with adjustable brush size and color
- **Line tool** — draw straight lines between two points
- **Undo / redo** — Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z (one step per stroke)
- **Save** — standard VS Code save (Cmd/Ctrl+S) writes PNG to disk
- **Remote SSH ready** — runs as a workspace extension on the remote host where your files live

## Getting started

1. Install **SSH Paint** from the VS Code Marketplace (or install the `.vsix` manually).
2. Connect to a remote host via Remote SSH (if editing remote files).
3. Open any `.png` file and choose **SSH Paint** from the editor picker, or set it as the default editor for PNG files.
4. Draw, save, done.

### Create a new image

Run the command **SSH Paint: New Image** from the Command Palette (`Cmd/Ctrl+Shift+P`). This creates a blank 64×64 PNG and opens it in the editor.

## Keyboard shortcuts

These work while the SSH Paint editor is focused:

| Key | Action |
|-----|--------|
| `P` or `B` | Pen tool |
| `L` | Line tool |
| `Cmd/Ctrl+Z` | Undo last stroke |
| `Cmd/Ctrl+Shift+Z` | Redo |
| `Cmd/Ctrl+S` | Save |

Brush size and color are adjusted via the toolbar.

## Remote SSH

SSH Paint is a **workspace extension** — it runs on the remote machine alongside your files. After installing, make sure it is enabled on the remote host:

1. Connect via Remote SSH.
2. Open the **Extensions** panel.
3. Find **SSH Paint** and click **Install in SSH: …** if prompted.

## Development

```bash
npm install
npm run compile
```

Press **F5** in VS Code to launch an Extension Development Host.

Package a `.vsix` for manual install:

```bash
npm run package
```

## License

[MIT](LICENSE) © Florian Bolli
