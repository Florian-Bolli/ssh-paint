import * as vscode from 'vscode';
import { PaintDocument } from './paintDocument';

type PixelBuffer = number[] | Uint8ClampedArray;

type WebviewInboundMessage =
	| { type: 'ready' }
	| { type: 'edit'; rgba: PixelBuffer }
	| { type: 'imageData'; rgba: PixelBuffer }
	| { type: 'status'; dirty: boolean; drawing: boolean }
	| { type: 'reloadRequest' };

type WebviewOutboundMessage =
	| { type: 'init'; width: number; height: number; rgba: PixelBuffer }
	| { type: 'reload'; width: number; height: number; rgba: PixelBuffer }
	| { type: 'setTool'; tool: 'pen' | 'line' | 'bucket' | 'picker' }
	| { type: 'queryStatus' }
	| { type: 'undo' }
	| { type: 'redo' }
	| { type: 'save' }
	| { type: 'saved' }
	| { type: 'reloadBlocked' };

function toClampedArray(rgba: PixelBuffer): Uint8ClampedArray {
	return rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba);
}

export class PaintEditorProvider implements vscode.CustomEditorProvider<PaintDocument> {
	private static readonly RELOAD_INTERVAL_MS = 10_000;

	private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
		vscode.CustomDocumentEditEvent<PaintDocument>
	>();
	readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

	private readonly _editors = new Map<string, vscode.WebviewPanel>();
	private _activeUri: vscode.Uri | undefined;

	constructor(private readonly _extensionUri: vscode.Uri) {}

	static register(context: vscode.ExtensionContext): PaintEditorProvider {
		const provider = new PaintEditorProvider(context.extensionUri);
		context.subscriptions.push(
			vscode.window.registerCustomEditorProvider('sshPaint.editor', provider, {
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: false,
			}),
		);
		return provider;
	}

	async openCustomDocument(
		uri: vscode.Uri,
		openContext: { backupId?: string },
		_token: vscode.CancellationToken,
	): Promise<PaintDocument> {
		const result = await PaintDocument.create(uri, openContext.backupId);
		return result;
	}

	async resolveCustomEditor(
		document: PaintDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken,
	): Promise<void> {
		const key = document.uri.toString();
		this._editors.set(key, webviewPanel);

		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		};
		webviewPanel.webview.html = this._getHtml(webviewPanel.webview);

		const post = (message: WebviewOutboundMessage) => {
			webviewPanel.webview.postMessage(message);
		};

		const sendInit = () => {
			const image = document.getImage();
			post({
				type: 'init',
				width: image.width,
				height: image.height,
				rgba: image.rgba,
			});
		};

		const historySync = {
			onUndo: () => post({ type: 'undo' }),
			onRedo: () => post({ type: 'redo' }),
		};

		sendInit();

		const changeSubscription = document.onDidChange((e) => {
			this._onDidChangeCustomDocument.fire(e);
		});

		const messageSubscription = webviewPanel.webview.onDidReceiveMessage(
			(message: WebviewInboundMessage) => {
				switch (message.type) {
					case 'ready':
						sendInit();
						break;
					case 'edit':
						document.updateImage(toClampedArray(message.rgba), historySync);
						break;
					case 'reloadRequest':
						void this._reloadFromDisk(document, webviewPanel, { force: true });
						break;
				}
			},
		);

		const reloadTimer = setInterval(() => {
			void this._reloadFromDisk(document, webviewPanel, { force: false });
		}, PaintEditorProvider.RELOAD_INTERVAL_MS);

		webviewPanel.onDidChangeViewState((e) => {
			if (e.webviewPanel.active) {
				this._activeUri = document.uri;
			}
		});

		if (webviewPanel.active) {
			this._activeUri = document.uri;
		}

		webviewPanel.onDidDispose(() => {
			clearInterval(reloadTimer);
			this._editors.delete(key);
			if (this._activeUri?.toString() === key) {
				this._activeUri = undefined;
			}
			changeSubscription.dispose();
			messageSubscription.dispose();
		});
	}

	async saveCustomDocument(
		document: PaintDocument,
		cancellation: vscode.CancellationToken,
	): Promise<void> {
		const rgba = await this._requestImageData(document);
		if (rgba) {
			document.setImageSilent(rgba);
		}
		await document.save(cancellation);
		const panel = this._editors.get(document.uri.toString());
		panel?.webview.postMessage({ type: 'saved' } satisfies WebviewOutboundMessage);
	}

	async saveCustomDocumentAs(
		document: PaintDocument,
		destination: vscode.Uri,
		cancellation: vscode.CancellationToken,
	): Promise<void> {
		const rgba = await this._requestImageData(document);
		const image = rgba ?? document.getImage().rgba;
		const { encodePng } = await import('@lunapaint/png-codec');
		const encoded = await encodePng({
			data: new Uint8Array(image),
			width: document.width,
			height: document.height,
		});
		if (cancellation.isCancellationRequested) {
			return;
		}
		await vscode.workspace.fs.writeFile(destination, encoded.data);
	}

	private _queryWebviewStatus(
		panel: vscode.WebviewPanel,
	): Promise<{ dirty: boolean; drawing: boolean }> {
		return new Promise((resolve) => {
			const timeout = setTimeout(() => resolve({ dirty: false, drawing: false }), 1000);
			const sub = panel.webview.onDidReceiveMessage((message: WebviewInboundMessage) => {
				if (message.type === 'status') {
					clearTimeout(timeout);
					sub.dispose();
					resolve({ dirty: message.dirty, drawing: message.drawing });
				}
			});
			panel.webview.postMessage({ type: 'queryStatus' } satisfies WebviewOutboundMessage);
		});
	}

	private async _reloadFromDisk(
		document: PaintDocument,
		panel: vscode.WebviewPanel,
		options: { force: boolean },
	): Promise<void> {
		if (document.hasUnsavedChanges()) {
			if (!options.force) {
				return;
			}
			const answer = await vscode.window.showWarningMessage(
				'Discard unsaved changes and reload from disk?',
				{ modal: true },
				'Reload',
			);
			if (answer !== 'Reload') {
				panel.webview.postMessage({ type: 'reloadBlocked' } satisfies WebviewOutboundMessage);
				return;
			}
		}

		const status = await this._queryWebviewStatus(panel);
		if (!options.force && (status.dirty || status.drawing)) {
			return;
		}

		const image = await document.reloadFromDisk();
		if (!image) {
			if (options.force) {
				panel.webview.postMessage({ type: 'reloadBlocked' } satisfies WebviewOutboundMessage);
			}
			return;
		}

		panel.webview.postMessage({
			type: 'reload',
			width: image.width,
			height: image.height,
			rgba: image.rgba,
		} satisfies WebviewOutboundMessage);
	}

	private _requestImageData(document: PaintDocument): Promise<Uint8ClampedArray | undefined> {
		const panel = this._editors.get(document.uri.toString());
		if (!panel) {
			return Promise.resolve(undefined);
		}
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('Save timed out')), 10000);
			const sub = panel.webview.onDidReceiveMessage((message: WebviewInboundMessage) => {
				if (message.type === 'imageData') {
					clearTimeout(timeout);
					sub.dispose();
					resolve(toClampedArray(message.rgba));
				}
			});
			panel.webview.postMessage({ type: 'save' } satisfies WebviewOutboundMessage);
		});
	}

	async revertCustomDocument(
		document: PaintDocument,
		_cancellation: vscode.CancellationToken,
	): Promise<void> {
		document.revert();
		const panel = this._editors.get(document.uri.toString());
		if (panel) {
			const image = document.getImage();
			panel.webview.postMessage({
				type: 'init',
				width: image.width,
				height: image.height,
				rgba: image.rgba,
			} satisfies WebviewOutboundMessage);
		}
	}

	async backupCustomDocument(
		document: PaintDocument,
		context: vscode.CustomDocumentBackupContext,
		_cancellation: vscode.CancellationToken,
	): Promise<vscode.CustomDocumentBackup> {
		const { encodePng } = await import('@lunapaint/png-codec');
		const image = document.getImage();
		const encoded = await encodePng({
			data: new Uint8Array(image.rgba),
			width: image.width,
			height: image.height,
		});
		await vscode.workspace.fs.writeFile(context.destination, encoded.data);
		return {
			id: context.destination.toString(),
			delete: async () => {
				try {
					await vscode.workspace.fs.delete(context.destination);
				} catch {
					// ignore
				}
			},
		};
	}

	setTool(tool: 'pen' | 'line' | 'bucket' | 'picker'): void {
		if (!this._activeUri) {
			return;
		}
		const panel = this._editors.get(this._activeUri.toString());
		panel?.webview.postMessage({ type: 'setTool', tool } satisfies WebviewOutboundMessage);
	}

	private _getHtml(webview: vscode.Webview): string {
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'media', 'editor.css'),
		);
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'media', 'editor.js'),
		);
		const icon = (name: string) =>
			webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'icons', name));
		const brushIconUri = icon('icon-brush.png');
		const lineIconUri = icon('icon-line.png');
		const bucketIconUri = icon('icon-bucket.png');
		const pickerIconUri = icon('icon-picker.png');
		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${styleUri}" rel="stylesheet">
	<title>SSH Paint</title>
</head>
<body>
	<div id="toolbar">
		<div id="tools" role="toolbar" aria-label="Tools">
			<button type="button" class="tool active" data-tool="pen" title="Brush (P)" aria-label="Brush">
				<img class="tool-img" src="${brushIconUri}" width="20" height="20" alt="">
			</button>
			<button type="button" class="tool" data-tool="line" title="Line (L)" aria-label="Line">
				<img class="tool-img" src="${lineIconUri}" width="20" height="20" alt="">
			</button>
			<button type="button" class="tool" data-tool="bucket" title="Fill bucket (G)" aria-label="Fill bucket">
				<img class="tool-img" src="${bucketIconUri}" width="20" height="20" alt="">
			</button>
			<button type="button" class="tool" data-tool="picker" title="Color picker (I)" aria-label="Color picker">
				<img class="tool-img" src="${pickerIconUri}" width="20" height="20" alt="">
			</button>
		</div>
		<label class="field size-field">
			<span class="field-label">Size</span>
			<input type="range" id="size" min="1" max="32" value="1">
			<input type="number" id="size-num" class="size-num" min="1" max="32" value="1" aria-label="Brush size in pixels">
			<span class="size-unit">px</span>
		</label>
		<label class="field">Color <input type="color" id="color" value="#000000"></label>
		<button type="button" id="reload-btn" class="tool reload-btn" title="Reload from disk">↻</button>
		<span id="status"></span>
	</div>
	<div id="viewport">
		<div id="canvas-wrap">
			<div id="canvas-stage">
				<canvas id="canvas"></canvas>
			</div>
		</div>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}
