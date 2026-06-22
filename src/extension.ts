import * as vscode from 'vscode';
import { PaintEditorProvider } from './paintEditorProvider';
import { DEFAULT_PNG_ENCODE_PROFILE, encodePngWithProfile } from './pngEncode';

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
		vscode.commands.registerCommand('sshPaint.tool.picker', () => {
			provider?.setTool('picker');
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

	const pngBytes = await encodePngWithProfile(rgba, width, height, DEFAULT_PNG_ENCODE_PROFILE);
	await vscode.workspace.fs.writeFile(uri, pngBytes);
	await vscode.commands.executeCommand('vscode.openWith', uri, 'sshPaint.editor');
}
