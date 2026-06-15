import * as vscode from 'vscode';
import { PaintEditorProvider } from './paintEditorProvider';

let provider: PaintEditorProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
	provider = PaintEditorProvider.register(context);

	context.subscriptions.push(
		vscode.commands.registerCommand('sshPaint.tool.pen', () => {
			provider?.setTool('pen');
		}),
		vscode.commands.registerCommand('sshPaint.tool.line', () => {
			provider?.setTool('line');
		}),
		vscode.commands.registerCommand('sshPaint.tool.bucket', () => {
			provider?.setTool('bucket');
		}),
		vscode.commands.registerCommand('sshPaint.file.new', () => createNewImage()),
	);
}

export function deactivate(): void {
	provider = undefined;
}

async function createNewImage(): Promise<void> {
	const uri = await vscode.window.showSaveDialog({
		filters: { PNG: ['png'] },
		saveLabel: 'Create Image',
	});
	if (!uri) {
		return;
	}

	const width = 64;
	const height = 64;
	const rgba = new Uint8ClampedArray(width * height * 4);

	const { encodePng } = await import('@lunapaint/png-codec');
	const encoded = await encodePng({ data: new Uint8Array(rgba), width, height });
	await vscode.workspace.fs.writeFile(uri, encoded.data);
	await vscode.commands.executeCommand('vscode.openWith', uri, 'sshPaint.editor');
}
