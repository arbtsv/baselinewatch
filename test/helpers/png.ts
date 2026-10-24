// A strict PNG reader for the e2e checks of the screenshot. It decodes only what Playwright's
// Chromium produces (8-bit RGB or RGBA, not interlaced) and throws on everything else, so a pixel
// check can never run over garbage: an unsupported variant, a corrupt chunk, a short or long pixel
// stream and bytes after IEND all fail loudly.
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PIXELS = 64 * 1024 * 1024;

export type DecodedPng = {
  width: number;
  height: number;
  /** 3 for RGB, 4 for RGBA. */
  channels: 3 | 4;
  /** Unfiltered samples, row after row, without the filter bytes. */
  pixels: Buffer;
};

/** A pixel rectangle: x0 and y0 are inside, x1 and y1 are just outside. */
export type PixelArea = { x0: number; y0: number; x1: number; y1: number };

type Chunk = { type: string; data: Buffer };

function chunksOf(png: Buffer): Chunk[] {
  if (png.length < SIGNATURE.length || !png.subarray(0, SIGNATURE.length).equals(SIGNATURE)) {
    throw new Error('not a PNG: the signature is wrong');
  }
  const chunks: Chunk[] = [];
  let offset = SIGNATURE.length;
  while (offset < png.length) {
    if (offset + 12 > png.length) throw new Error('corrupt PNG: a chunk header is cut off');
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > png.length) throw new Error('corrupt PNG: a chunk runs past the end of the file');
    const type = png.toString('latin1', offset + 4, offset + 8);
    if (zlib.crc32(png.subarray(offset + 4, end - 4)) !== png.readUInt32BE(end - 4)) {
      throw new Error(`corrupt PNG: the checksum of the ${type} chunk is wrong`);
    }
    chunks.push({ type, data: png.subarray(offset + 8, end - 4) });
    offset = end;
    if (type === 'IEND') break;
  }
  if (chunks.at(-1)?.type !== 'IEND') throw new Error('corrupt PNG: no IEND chunk');
  if (offset !== png.length) throw new Error('corrupt PNG: bytes after IEND');
  return chunks;
}

function paeth(left: number, up: number, upLeft: number): number {
  const guess = left + up - upLeft;
  const dl = Math.abs(guess - left);
  const du = Math.abs(guess - up);
  const dul = Math.abs(guess - upLeft);
  return dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
}

/** Decodes a PNG or throws; see the module comment for what is supported. */
export function decodePng(png: Buffer): DecodedPng {
  const chunks = chunksOf(png);
  const header = chunks[0];
  if (header?.type !== 'IHDR' || header.data.length !== 13) throw new Error('corrupt PNG: IHDR must be the first chunk');
  if (chunks.filter((chunk) => chunk.type === 'IHDR').length !== 1) throw new Error('corrupt PNG: more than one IHDR');
  const width = header.data.readUInt32BE(0);
  const height = header.data.readUInt32BE(4);
  const [bitDepth, colourType, compression, filterMethod, interlace] = [8, 9, 10, 11, 12].map((at) => header.data[at]);
  if (width === 0 || height === 0 || width * height > MAX_PIXELS) throw new Error(`unsupported PNG size ${width}x${height}`);
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (colourType !== 2 && colourType !== 6) throw new Error(`unsupported PNG colour type ${colourType}`);
  if (compression !== 0 || filterMethod !== 0) throw new Error('unsupported PNG compression or filter method');
  if (interlace !== 0) throw new Error(`unsupported PNG interlace method ${interlace}`);
  const idat = chunks.map((chunk, index) => ({ chunk, index })).filter(({ chunk }) => chunk.type === 'IDAT');
  if (idat.length === 0) throw new Error('corrupt PNG: no IDAT chunk');
  const first = idat[0]?.index ?? 0;
  if (idat.some(({ index }, n) => index !== first + n)) throw new Error('corrupt PNG: the IDAT chunks are not consecutive');
  const channels = colourType === 6 ? 4 : 3;
  const stride = width * channels;
  const expected = (stride + 1) * height;
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat.map(({ chunk }) => chunk.data)), { maxOutputLength: expected + 1 });
  } catch (error) {
    throw new Error(`corrupt PNG: the pixel data does not inflate (${(error as Error).message})`);
  }
  if (raw.length !== expected) throw new Error(`corrupt PNG: ${raw.length} bytes of pixel data, expected ${expected}`);
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] as number;
    if (filter > 4) throw new Error(`corrupt PNG: filter type ${filter} in row ${y}`);
    const source = y * (stride + 1) + 1;
    const target = y * stride;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? (pixels[target + i - channels] as number) : 0;
      const up = y > 0 ? (pixels[target - stride + i] as number) : 0;
      const upLeft = y > 0 && i >= channels ? (pixels[target - stride + i - channels] as number) : 0;
      const add = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
      pixels[target + i] = ((raw[source + i] as number) + add) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/** The red, green, blue and alpha samples of a pixel; alpha is 255 for an RGB image. */
export function pixelAt(image: DecodedPng, x: number, y: number): [number, number, number, number] {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
    throw new RangeError(`pixel ${x},${y} is outside the ${image.width}x${image.height} image`);
  }
  const at = (y * image.width + x) * image.channels;
  const px = image.pixels;
  return [px[at] as number, px[at + 1] as number, px[at + 2] as number, image.channels === 4 ? (px[at + 3] as number) : 255];
}

/**
 * The device-pixel area to inspect inside a mask: the element box in CSS pixels, shrunk by margin CSS
 * pixels on every side, scaled by the device scale factor and rounded inwards, so no pixel that the
 * browser may blend at a fractional edge is part of it. Throws when nothing is left of the box.
 */
export function maskCheckArea(box: { x: number; y: number; width: number; height: number }, scale: number, margin = 2): PixelArea {
  const area = {
    x0: Math.ceil((box.x + margin) * scale),
    y0: Math.ceil((box.y + margin) * scale),
    x1: Math.floor((box.x + box.width - margin) * scale),
    y1: Math.floor((box.y + box.height - margin) * scale),
  };
  if (area.x1 <= area.x0 || area.y1 <= area.y0) {
    throw new RangeError(`the box ${box.width}x${box.height} is too small for a margin of ${margin}`);
  }
  return area;
}

/** How many pixels of the area differ from the colour (alpha must be 255). Throws when the area is empty or outside the image. */
export function countNotColour(image: DecodedPng, area: PixelArea, colour: readonly [number, number, number]): number {
  if (area.x1 <= area.x0 || area.y1 <= area.y0) throw new RangeError('the area to inspect is empty');
  let different = 0;
  for (let y = area.y0; y < area.y1; y += 1) {
    for (let x = area.x0; x < area.x1; x += 1) {
      const [r, g, b, a] = pixelAt(image, x, y);
      if (r !== colour[0] || g !== colour[1] || b !== colour[2] || a !== 255) different += 1;
    }
  }
  return different;
}

/** How many pixels of the whole image are exactly the colour (alpha 255). */
export function countColour(image: DecodedPng, colour: readonly [number, number, number]): number {
  let found = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const [r, g, b, a] = pixelAt(image, x, y);
      if (r === colour[0] && g === colour[1] && b === colour[2] && a === 255) found += 1;
    }
  }
  return found;
}
