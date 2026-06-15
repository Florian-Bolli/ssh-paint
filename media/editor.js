// @ts-check
(function () {
	const vscode = acquireVsCodeApi();

	const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('canvas'));
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	const statusEl = /** @type {HTMLSpanElement} */ (document.getElementById('status'));
	const sizeInput = /** @type {HTMLInputElement} */ (document.getElementById('size'));
	const colorInput = /** @type {HTMLInputElement} */ (document.getElementById('color'));

	if (!ctx) {
		throw new Error('Canvas 2D not available');
	}

	/** @type {'pen' | 'line'} */
	let tool = 'pen';
	let brushSize = 1;
	let color = { r: 0, g: 0, b: 0, a: 255 };
	let width = 0;
	let height = 0;

	/** @type {ImageData | null} */
	let buffer = null;
	/** @type {Uint8ClampedArray | null} */
	let lineSnapshot = null;

	let drawing = false;
	let lineStart = null;
	/** @type {{ x: number; y: number } | null} */
	let lastPoint = null;
	let dirty = false;

	/** @type {Uint8ClampedArray[]} */
	let history = [];
	let historyIndex = -1;

	function resetHistory() {
		if (!buffer) {
			history = [];
			historyIndex = -1;
			return;
		}
		history = [new Uint8ClampedArray(buffer.data)];
		historyIndex = 0;
	}

	function pushHistory() {
		if (!buffer) {
			return;
		}
		history = history.slice(0, historyIndex + 1);
		history.push(new Uint8ClampedArray(buffer.data));
		historyIndex = history.length - 1;
	}

	function undoVisual() {
		if (!buffer || historyIndex <= 0) {
			return;
		}
		historyIndex--;
		buffer.data.set(history[historyIndex]);
		render();
		dirty = false;
	}

	function redoVisual() {
		if (!buffer || historyIndex >= history.length - 1) {
			return;
		}
		historyIndex++;
		buffer.data.set(history[historyIndex]);
		render();
		dirty = false;
	}

	function setStatus(text) {
		statusEl.textContent = text;
	}

	function setTool(next) {
		tool = next;
		document.querySelectorAll('.tool').forEach((btn) => {
			btn.classList.toggle('active', btn.getAttribute('data-tool') === next);
		});
		setStatus(`${next === 'pen' ? 'Pen' : 'Line'} · ${brushSize}px`);
	}

	function parseColor(hex) {
		const n = parseInt(hex.slice(1), 16);
		return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255 };
	}

	function initImage(w, h, rgba) {
		width = w;
		height = h;
		canvas.width = w;
		canvas.height = h;
		const data = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba);
		buffer = new ImageData(new Uint8ClampedArray(data), w, h);
		render();
		dirty = false;
		resetHistory();
		setStatus('Ready');
	}

	function render() {
		if (!buffer) {
			return;
		}
		ctx.putImageData(buffer, 0, 0);
	}

	function getPos(/** @type {MouseEvent} */ e) {
		const rect = canvas.getBoundingClientRect();
		const scaleX = canvas.width / rect.width;
		const scaleY = canvas.height / rect.height;
		return {
			x: Math.floor((e.clientX - rect.left) * scaleX),
			y: Math.floor((e.clientY - rect.top) * scaleY),
		};
	}

	function clamp(v, min, max) {
		return Math.max(min, Math.min(max, v));
	}

	function setPixel(x, y, r, g, b, a) {
		if (!buffer || x < 0 || y < 0 || x >= width || y >= height) {
			return;
		}
		const i = (y * width + x) * 4;
		if (a === 255) {
			buffer.data[i] = r;
			buffer.data[i + 1] = g;
			buffer.data[i + 2] = b;
			buffer.data[i + 3] = 255;
		} else if (a > 0) {
			const alpha = a / 255;
			buffer.data[i] = Math.round(buffer.data[i] * (1 - alpha) + r * alpha);
			buffer.data[i + 1] = Math.round(buffer.data[i + 1] * (1 - alpha) + g * alpha);
			buffer.data[i + 2] = Math.round(buffer.data[i + 2] * (1 - alpha) + b * alpha);
			buffer.data[i + 3] = 255;
		}
	}

	function stampBrush(x, y) {
		const half = Math.floor(brushSize / 2);
		for (let dy = -half; dy < brushSize - half; dy++) {
			for (let dx = -half; dx < brushSize - half; dx++) {
				setPixel(x + dx, y + dy, color.r, color.g, color.b, color.a);
			}
		}
	}

	function drawLine(x0, y0, x1, y1) {
		let dx = Math.abs(x1 - x0);
		let dy = Math.abs(y1 - y0);
		const sx = x0 < x1 ? 1 : -1;
		const sy = y0 < y1 ? 1 : -1;
		let err = dx - dy;

		while (true) {
			stampBrush(x0, y0);
			if (x0 === x1 && y0 === y1) {
				break;
			}
			const e2 = 2 * err;
			if (e2 > -dy) {
				err -= dy;
				x0 += sx;
			}
			if (e2 < dx) {
				err += dx;
				y0 += sy;
			}
		}
	}

	function commitEdit() {
		if (!buffer || !dirty) {
			return;
		}
		pushHistory();
		vscode.postMessage({ type: 'edit', rgba: new Uint8ClampedArray(buffer.data) });
		dirty = false;
	}

	function onPointerDown(e) {
		if (e.button !== 0 || !buffer) {
			return;
		}
		const p = getPos(e);
		const x = clamp(p.x, 0, width - 1);
		const y = clamp(p.y, 0, height - 1);
		drawing = true;
		lastPoint = { x, y };

		if (tool === 'pen') {
			stampBrush(x, y);
			render();
			dirty = true;
		} else {
			lineStart = { x, y };
			lineSnapshot = new Uint8ClampedArray(buffer.data);
		}
	}

	function onPointerMove(e) {
		if (!drawing || !buffer) {
			return;
		}
		const p = getPos(e);
		const x = clamp(p.x, 0, width - 1);
		const y = clamp(p.y, 0, height - 1);

		if (tool === 'pen') {
			if (lastPoint) {
				drawLine(lastPoint.x, lastPoint.y, x, y);
			}
			lastPoint = { x, y };
			render();
			dirty = true;
		} else if (lineStart && lineSnapshot) {
			buffer.data.set(lineSnapshot);
			drawLine(lineStart.x, lineStart.y, x, y);
			render();
		}
	}

	function onPointerUp(e) {
		if (!drawing || !buffer) {
			return;
		}
		const p = getPos(e);
		const x = clamp(p.x, 0, width - 1);
		const y = clamp(p.y, 0, height - 1);

		if (tool === 'line' && lineStart && lineSnapshot) {
			buffer.data.set(lineSnapshot);
			drawLine(lineStart.x, lineStart.y, x, y);
			render();
			dirty = true;
		}

		drawing = false;
		lastPoint = null;
		lineStart = null;
		lineSnapshot = null;
		commitEdit();
	}

	canvas.addEventListener('mousedown', onPointerDown);
	canvas.addEventListener('mousemove', onPointerMove);
	window.addEventListener('mouseup', onPointerUp);

	document.querySelectorAll('.tool').forEach((btn) => {
		btn.addEventListener('click', () => {
			const t = /** @type {'pen' | 'line'} */ (btn.getAttribute('data-tool'));
			setTool(t);
		});
	});

	sizeInput.addEventListener('input', () => {
		brushSize = parseInt(sizeInput.value, 10) || 1;
		setStatus(`${tool === 'pen' ? 'Pen' : 'Line'} · ${brushSize}px`);
	});

	colorInput.addEventListener('input', () => {
		color = parseColor(colorInput.value);
	});

	window.addEventListener('message', (event) => {
		const message = event.data;
		switch (message.type) {
			case 'init':
				initImage(message.width, message.height, message.rgba);
				break;
			case 'setTool':
				setTool(message.tool);
				break;
			case 'undo':
				undoVisual();
				break;
			case 'redo':
				redoVisual();
				break;
			case 'save':
				if (buffer) {
					vscode.postMessage({ type: 'imageData', rgba: new Uint8ClampedArray(buffer.data) });
				}
				break;
			case 'saved':
				setStatus('Saved');
				break;
		}
	});

	vscode.postMessage({ type: 'ready' });
	setTool('pen');
})();
