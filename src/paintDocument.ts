import { decodePng, encodePng } from '@lunapaint/png-codec';
import * as vscode from 'vscode';

export interface PaintImageData {
	width: number;
	height: number;
	rgba: Uint8ClampedArray;
}

function toImage32(rgba: Uint8ClampedArray, width: number, height: number) {
	return { data: new Uint8Array(rgba), width, height };
}

function arraysEqual(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}

export class PaintDocument implements vscode.CustomDocument {
	static async create(uri: vscode.Uri, backupId?: string): Promise<PaintDocument> {
		const fileUri = backupId ? vscode.Uri.parse(backupId) : uri;
		const bytes = new Uint8Array(await vscode.workspace.fs.readFile(fileUri));
		const decoded = await decodePng(bytes);
		const rgba = new Uint8ClampedArray(decoded.image.data);
		return new PaintDocument(uri, decoded.image.width, decoded.image.height, rgba);
	}

	private readonly _onDidDispose = new vscode.EventEmitter<void>();
	readonly onDidDispose = this._onDidDispose.event;

	private readonly _onDidChange = new vscode.EventEmitter<
		vscode.CustomDocumentEditEvent<PaintDocument>
	>();
	readonly onDidChange = this._onDidChange.event;

	private _savedRgba: Uint8ClampedArray;

	private constructor(
		public readonly uri: vscode.Uri,
		public width: number,
		public height: number,
		private _rgba: Uint8ClampedArray,
	) {
		this._savedRgba = new Uint8ClampedArray(_rgba);
	}

	getImage(): PaintImageData {
		return {
			width: this.width,
			height: this.height,
			rgba: this._rgba,
		};
	}

	setImageSilent(rgba: Uint8ClampedArray): void {
		if (rgba.length !== this._rgba.length) {
			throw new Error('Image buffer size mismatch');
		}
		this._rgba = new Uint8ClampedArray(rgba);
	}

	updateImage(
		rgba: Uint8ClampedArray,
		sync: { onUndo: () => void; onRedo: () => void },
	): void {
		if (rgba.length !== this._rgba.length) {
			throw new Error('Image buffer size mismatch');
		}
		const before = new Uint8ClampedArray(this._rgba);
		const after = new Uint8ClampedArray(rgba);
		if (arraysEqual(before, after)) {
			return;
		}
		this._rgba = after;
		this._onDidChange.fire({
			document: this,
			label: 'Edit',
			undo: () => {
				this._rgba = new Uint8ClampedArray(before);
				sync.onUndo();
			},
			redo: () => {
				this._rgba = new Uint8ClampedArray(after);
				sync.onRedo();
			},
		});
	}

	isDirty(currentRgba: Uint8ClampedArray): boolean {
		if (currentRgba.length !== this._savedRgba.length) {
			return true;
		}
		for (let i = 0; i < currentRgba.length; i++) {
			if (currentRgba[i] !== this._savedRgba[i]) {
				return true;
			}
		}
		return false;
	}

	hasUnsavedChanges(): boolean {
		return this.isDirty(this._rgba);
	}

	async reloadFromDisk(): Promise<PaintImageData | null> {
		try {
			const bytes = new Uint8Array(await vscode.workspace.fs.readFile(this.uri));
			const decoded = await decodePng(bytes);
			const rgba = new Uint8ClampedArray(decoded.image.data);
			const sameSize =
				decoded.image.width === this.width &&
				decoded.image.height === this.height &&
				rgba.length === this._rgba.length;
			if (sameSize && arraysEqual(rgba, this._rgba)) {
				return null;
			}
			this.width = decoded.image.width;
			this.height = decoded.image.height;
			this._rgba = rgba;
			this._savedRgba = new Uint8ClampedArray(rgba);
			return this.getImage();
		} catch {
			return null;
		}
	}

	markSaved(rgba: Uint8ClampedArray): void {
		this._savedRgba = new Uint8ClampedArray(rgba);
	}

	revert(): void {
		this._rgba = new Uint8ClampedArray(this._savedRgba);
	}

	async save(cancellation: vscode.CancellationToken): Promise<void> {
		if (cancellation.isCancellationRequested) {
			return;
		}
		const encoded = await encodePng(toImage32(this._rgba, this.width, this.height));
		await vscode.workspace.fs.writeFile(this.uri, encoded.data);
		this.markSaved(this._rgba);
	}

	dispose(): void {
		this._onDidDispose.fire();
		this._onDidDispose.dispose();
		this._onDidChange.dispose();
	}
}
