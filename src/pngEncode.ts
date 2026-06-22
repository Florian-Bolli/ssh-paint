import { ColorType, encodePng, type BitDepth } from '@lunapaint/png-codec';

export interface PngEncodeProfile {
	bitDepth: BitDepth;
	colorType: ColorType;
}

export const DEFAULT_PNG_ENCODE_PROFILE: PngEncodeProfile = {
	bitDepth: 8,
	colorType: ColorType.TruecolorAndAlpha,
};

function toGrayscale(rgba: Uint8ClampedArray, colorType: ColorType): Uint8ClampedArray {
	const out = new Uint8ClampedArray(rgba);
	for (let i = 0; i < out.length; i += 4) {
		const gray = Math.round(0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2]);
		out[i] = gray;
		out[i + 1] = gray;
		out[i + 2] = gray;
		if (colorType === ColorType.Grayscale) {
			out[i + 3] = 255;
		}
	}
	return out;
}

function prepareRgbaForProfile(
	rgba: Uint8ClampedArray,
	profile: PngEncodeProfile,
): Uint8ClampedArray {
	switch (profile.colorType) {
		case ColorType.Grayscale:
		case ColorType.GrayscaleAndAlpha:
			return toGrayscale(rgba, profile.colorType);
		case ColorType.Truecolor: {
			const out = new Uint8ClampedArray(rgba);
			for (let i = 3; i < out.length; i += 4) {
				out[i] = 255;
			}
			return out;
		}
		default:
			return rgba;
	}
}

export async function encodePngWithProfile(
	rgba: Uint8ClampedArray,
	width: number,
	height: number,
	profile: PngEncodeProfile,
): Promise<Uint8Array> {
	const prepared = prepareRgbaForProfile(rgba, profile);
	const options = { bitDepth: profile.bitDepth, colorType: profile.colorType };

	if (profile.bitDepth === 16) {
		const data = new Uint16Array(prepared.length);
		for (let i = 0; i < prepared.length; i++) {
			data[i] = prepared[i] * 257;
		}
		const encoded = await encodePng({ data, width, height }, options);
		return encoded.data;
	}

	const encoded = await encodePng(
		{ data: new Uint8Array(prepared), width, height },
		options,
	);
	return encoded.data;
}

export function profileFromDecoded(details: {
	bitDepth: BitDepth;
	colorType: ColorType;
}): PngEncodeProfile {
	return {
		bitDepth: details.bitDepth,
		colorType: details.colorType,
	};
}
