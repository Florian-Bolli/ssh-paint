// @ts-check
(function () {
	const vscode = acquireVsCodeApi();

	const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('canvas'));
	const viewport = /** @type {HTMLDivElement} */ (document.getElementById('viewport'));
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	const statusEl = /** @type {HTMLSpanElement} */ (document.getElementById('status'));
	const sizeInput = /** @type {HTMLInputElement} */ (document.getElementById('size'));
	const sizeNumInput = /** @type {HTMLInputElement} */ (document.getElementById('size-num'));
	const colorInput = /** @type {HTMLInputElement} */ (document.getElementById('color'));

	if (!ctx) {
		throw new Error('Canvas 2D not available');
	}

	/** @type {'pen' | 'line' | 'bucket' | 'picker'} */
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

	let spaceHeld = false;
	let panning = false;
	/** @type {{ x: number; y: number; scrollLeft: number; scrollTop: number } | null} */
	let panStart = null;
	let zoom = 1;
	const MAX_ZOOM = 32;
	const FIT_PADDING = 32;

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

	function applyZoom() {
		canvas.style.width = `${width * zoom}px`;
		canvas.style.height = `${height * zoom}px`;
	}

	function getFitZoom() {
		if (!width || !height) {
			return 1;
		}
		const pad = FIT_PADDING * 2;
		const availableW = Math.max(1, viewport.clientWidth - pad);
		const availableH = Math.max(1, viewport.clientHeight - pad);
		return Math.min(availableW / width, availableH / height);
	}

	function getWidthFitZoom() {
		if (!width || !height) {
			return 1;
		}
		const pad = FIT_PADDING * 2;
		const availableW = Math.max(1, viewport.clientWidth - pad);
		return availableW / width;
	}

	function getDefaultOpenZoom() {
		return clamp(getWidthFitZoom(), getMinZoom(), MAX_ZOOM);
	}

	function getMinZoom() {
		const fit = getFitZoom();
		return fit < 1 ? fit : 1;
	}

	function getContentSize() {
		const pad = FIT_PADDING * 2;
		return {
			width: width * zoom + pad,
			height: height * zoom + pad,
		};
	}

	function centerView() {
		const content = getContentSize();
		viewport.scrollLeft = Math.max(0, (content.width - viewport.clientWidth) / 2);
		viewport.scrollTop = Math.max(0, (content.height - viewport.clientHeight) / 2);
	}

	function scrollToDefaultView() {
		const content = getContentSize();
		viewport.scrollLeft = Math.max(0, (content.width - viewport.clientWidth) / 2);
		if (content.height <= viewport.clientHeight) {
			viewport.scrollTop = Math.max(0, (content.height - viewport.clientHeight) / 2);
		} else {
			viewport.scrollTop = 0;
		}
	}

	function applyDefaultView() {
		if (viewport.clientWidth <= 0) {
			zoom = 1;
			applyZoom();
			return;
		}
		zoom = getDefaultOpenZoom();
		applyZoom();
		scrollToDefaultView();
	}

	function zoomAt(clientX, clientY, factor) {
		const next = clamp(zoom * factor, getMinZoom(), MAX_ZOOM);
		if (next === zoom) {
			return;
		}

		const rect = canvas.getBoundingClientRect();
		const offsetX = clientX - rect.left;
		const offsetY = clientY - rect.top;
		const ratio = next / zoom;
		const scrollX = viewport.scrollLeft + offsetX;
		const scrollY = viewport.scrollTop + offsetY;

		zoom = next;
		applyZoom();

		viewport.scrollLeft = scrollX * ratio - offsetX;
		viewport.scrollTop = scrollY * ratio - offsetY;

		if (next === getMinZoom()) {
			centerView();
		}
	}

	function isPanButton(/** @type {MouseEvent} */ e) {
		return e.button === 1 || (e.button === 0 && spaceHeld);
	}

	function startPan(/** @type {MouseEvent} */ e) {
		panning = true;
		panStart = {
			x: e.clientX,
			y: e.clientY,
			scrollLeft: viewport.scrollLeft,
			scrollTop: viewport.scrollTop,
		};
		viewport.classList.add('panning');
		e.preventDefault();
	}

	function onPanMove(/** @type {MouseEvent} */ e) {
		if (!panning || !panStart) {
			return;
		}
		viewport.scrollLeft = panStart.scrollLeft - (e.clientX - panStart.x);
		viewport.scrollTop = panStart.scrollTop - (e.clientY - panStart.y);
		e.preventDefault();
	}

	function endPan() {
		if (!panning) {
			return;
		}
		panning = false;
		panStart = null;
		viewport.classList.remove('panning');
	}

	function setStatus(text) {
		statusEl.textContent = text;
	}

	function setTool(next) {
		tool = next;
		document.querySelectorAll('.tool').forEach((btn) => {
			btn.classList.toggle('active', btn.getAttribute('data-tool') === next);
		});
		canvas.classList.toggle('tool-picker', next === 'picker');
		if (next === 'bucket') {
			setStatus('Bucket');
		} else if (next === 'picker') {
			setStatus('Picker — click to sample');
		} else {
			setStatus(`${next === 'pen' ? 'Brush' : 'Line'} · ${brushSize}px`);
		}
	}

	function toolLabel() {
		if (tool === 'pen') {
			return 'Brush';
		}
		if (tool === 'line') {
			return 'Line';
		}
		if (tool === 'bucket') {
			return 'Bucket';
		}
		return 'Picker';
	}

	function toHex(r, g, b) {
		return (
			'#' +
			[r, g, b]
				.map((c) => c.toString(16).padStart(2, '0'))
				.join('')
		);
	}

	function pickColor(x, y) {
		if (!buffer) {
			return;
		}
		const i = (y * width + x) * 4;
		const r = buffer.data[i];
		const g = buffer.data[i + 1];
		const b = buffer.data[i + 2];
		color = { r, g, b, a: 255 };
		colorInput.value = toHex(r, g, b);
		setStatus(`Picked ${toHex(r, g, b)}`);
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
		applyDefaultView();
		requestAnimationFrame(applyDefaultView);
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

	function setBrushSize(next) {
		brushSize = clamp(Math.round(next) || 1, 1, 32);
		sizeInput.value = String(brushSize);
		sizeNumInput.value = String(brushSize);
		if (tool !== 'bucket' && tool !== 'picker') {
			setStatus(`${toolLabel()} · ${brushSize}px`);
		}
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

	function matchesColor(/** @type {number} */ i, r, g, b, a) {
		if (!buffer) {
			return false;
		}
		const data = buffer.data;
		return data[i] === r && data[i + 1] === g && data[i + 2] === b && data[i + 3] === a;
	}

	function floodFill(startX, startY) {
		if (!buffer) {
			return false;
		}
		const data = buffer.data;
		const startI = (startY * width + startX) * 4;
		const tr = data[startI];
		const tg = data[startI + 1];
		const tb = data[startI + 2];
		const ta = data[startI + 3];

		if (tr === color.r && tg === color.g && tb === color.b && ta === 255) {
			return false;
		}

		/** @type {[number, number][]} */
		const stack = [[startX, startY]];
		let changed = false;

		while (stack.length > 0) {
			const [x, y] = stack.pop();
			let left = x;
			while (left >= 0 && matchesColor((y * width + left) * 4, tr, tg, tb, ta)) {
				left--;
			}
			left++;

			let right = x;
			while (right < width && matchesColor((y * width + right) * 4, tr, tg, tb, ta)) {
				right++;
			}
			right--;

			for (let px = left; px <= right; px++) {
				const i = (y * width + px) * 4;
				data[i] = color.r;
				data[i + 1] = color.g;
				data[i + 2] = color.b;
				data[i + 3] = 255;
				changed = true;
			}

			for (const ny of [y - 1, y + 1]) {
				if (ny < 0 || ny >= height) {
					continue;
				}
				let inSpan = false;
				for (let px = left; px <= right; px++) {
					if (matchesColor((ny * width + px) * 4, tr, tg, tb, ta)) {
						if (!inSpan) {
							stack.push([px, ny]);
							inSpan = true;
						}
					} else {
						inSpan = false;
					}
				}
			}
		}

		return changed;
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
		if (!buffer || isPanButton(e) || spaceHeld) {
			return;
		}
		if (e.button !== 0) {
			return;
		}
		const p = getPos(e);
		const x = clamp(p.x, 0, width - 1);
		const y = clamp(p.y, 0, height - 1);

		if (tool === 'bucket') {
			if (floodFill(x, y)) {
				render();
				dirty = true;
				commitEdit();
			}
			return;
		}

		if (tool === 'picker') {
			pickColor(x, y);
			return;
		}

		drawing = true;
		lastPoint = { x, y };

		if (tool === 'pen') {
			stampBrush(x, y);
			render();
			dirty = true;
		} else if (tool === 'line') {
			lineStart = { x, y };
			lineSnapshot = new Uint8ClampedArray(buffer.data);
		}
	}

	function onPointerMove(e) {
		if (panning || !drawing || !buffer) {
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
		} else if (tool === 'line' && lineStart && lineSnapshot) {
			buffer.data.set(lineSnapshot);
			drawLine(lineStart.x, lineStart.y, x, y);
			render();
		}
	}

	function onPointerUp(e) {
		if (panning || !drawing || !buffer) {
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
	canvas.addEventListener('auxclick', (e) => {
		if (e.button === 1) {
			e.preventDefault();
		}
	});

	viewport.addEventListener('mousedown', (e) => {
		if (isPanButton(e)) {
			startPan(e);
		}
	});
	window.addEventListener('mousemove', onPanMove);
	window.addEventListener('mouseup', endPan);

	window.addEventListener('keydown', (e) => {
		if (e.code !== 'Space' || e.repeat) {
			return;
		}
		const tag = /** @type {HTMLElement} */ (e.target).tagName;
		if (tag === 'INPUT' || tag === 'BUTTON') {
			return;
		}
		spaceHeld = true;
		viewport.classList.add('pan-ready');
		e.preventDefault();
	});

	window.addEventListener('keyup', (e) => {
		if (e.code !== 'Space') {
			return;
		}
		spaceHeld = false;
		viewport.classList.remove('pan-ready');
		endPan();
	});

	viewport.addEventListener(
		'wheel',
		(e) => {
			if (!e.ctrlKey && !e.metaKey) {
				return;
			}
			e.preventDefault();
			const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
			zoomAt(e.clientX, e.clientY, factor);
		},
		{ passive: false },
	);

	window.addEventListener('blur', () => {
		spaceHeld = false;
		viewport.classList.remove('pan-ready');
		endPan();
	});

	document.querySelectorAll('.tool').forEach((btn) => {
		btn.addEventListener('click', () => {
			const t = /** @type {'pen' | 'line' | 'bucket' | 'picker'} */ (btn.getAttribute('data-tool'));
			setTool(t);
		});
	});

	sizeInput.addEventListener('input', () => {
		setBrushSize(parseInt(sizeInput.value, 10));
	});

	sizeNumInput.addEventListener('input', () => {
		setBrushSize(parseInt(sizeNumInput.value, 10));
	});

	sizeNumInput.addEventListener('change', () => {
		setBrushSize(parseInt(sizeNumInput.value, 10));
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
