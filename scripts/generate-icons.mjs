import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const iconsDir = path.join(root, 'media', 'icons');
const assetsDir = path.join(root, 'media', 'icons', 'source');

const tools = [
	{ src: 'gen-brush.png', out: 'icon-brush.png' },
	{ src: 'gen-line.png', out: 'icon-line.png' },
	{ src: 'gen-bucket.png', out: 'icon-bucket.png' },
	{ src: 'gen-picker.png', out: 'icon-picker.png' },
];

async function rasterToIcon(inputPath, outputPath) {
	const { data, info } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

	const out = Buffer.alloc(data.length);
	for (let i = 0; i < info.width * info.height; i++) {
		const o = i * 4;
		const r = data[o];
		const g = data[o + 1];
		const b = data[o + 2];
		const lum = 0.299 * r + 0.587 * g + 0.114 * b;
		if (lum > 48) {
			out[o] = 0;
			out[o + 1] = 0;
			out[o + 2] = 0;
			out[o + 3] = Math.min(255, Math.round((lum - 48) * 2.2));
		}
	}

	await sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
		.trim()
		.resize(32, 32, {
			fit: 'contain',
			background: { r: 0, g: 0, b: 0, alpha: 0 },
		})
		.png()
		.toFile(outputPath);
}

fs.mkdirSync(assetsDir, { recursive: true });
fs.mkdirSync(iconsDir, { recursive: true });

for (const { src, out } of tools) {
	const cursorAsset = path.join(
		'/Users/Florian/.cursor/projects/Users-Florian-CodeProjects-vscode-minimal-paint/assets',
		src,
	);
	const sourceAsset = path.join(assetsDir, src);
	const input = fs.existsSync(cursorAsset) ? cursorAsset : sourceAsset;

	if (!fs.existsSync(input)) {
		const svgPath = path.join(iconsDir, out.replace('.png', '.svg'));
		if (!fs.existsSync(svgPath)) {
			throw new Error(`Missing source for ${out}: ${input}`);
		}
		const svg = fs.readFileSync(svgPath);
		await sharp(svg, { density: 192 })
			.resize(32, 32)
			.png()
			.toFile(path.join(iconsDir, out));
		console.log(`Wrote ${out} (from SVG fallback)`);
		continue;
	}

	if (input === cursorAsset) {
		fs.copyFileSync(input, sourceAsset);
	}

	const outputPath = path.join(iconsDir, out);
	await rasterToIcon(sourceAsset, outputPath);
	console.log(`Wrote ${outputPath}`);
}
