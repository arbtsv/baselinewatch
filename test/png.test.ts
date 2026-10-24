// Tests for test/helpers/png.ts: the strict PNG reader of the screenshot checks and the geometry of
// the area that the mask check inspects. The test images are built in memory by a small encoder.
// Run: node --test test/png.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { countColour, countNotColour, decodePng, maskCheckArea, pixelAt } from './helpers/png.ts';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAGENTA = [0xff, 0x00, 0xff] as const;

/** One chunk with its length and CRC; crcShift spoils the checksum. */
function chunk(type: string, data: Buffer, crcShift = 0): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((zlib.crc32(Buffer.concat([head.subarray(4), data])) + crcShift) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

type HeaderOptions = { width: number; height: number; bitDepth?: number; colourType?: number; interlace?: number };

function header(options: HeaderOptions): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(options.width, 0);
  data.writeUInt32BE(options.height, 4);
  data[8] = options.bitDepth ?? 8;
  data[9] = options.colourType ?? 2;
  data[10] = 0;
  data[11] = 0;
  data[12] = options.interlace ?? 0;
  return chunk('IHDR', data);
}

const idat = (raw: Buffer): Buffer => chunk('IDAT', zlib.deflateSync(raw));
const iend = (): Buffer => chunk('IEND', Buffer.alloc(0));
const file = (...parts: Buffer[]): Buffer => Buffer.concat([SIGNATURE, ...parts]);

type Row = { filter: number; bytes: number[] };
const rawOf = (rows: Row[]): Buffer => Buffer.concat(rows.map((row) => Buffer.from([row.filter, ...row.bytes])));

/** A 2x2 RGB image: the second row is stored with the Up filter. */
const UP_ROWS: Row[] = [
  { filter: 0, bytes: [10, 20, 30, 40, 50, 60] },
  { filter: 2, bytes: [1, 1, 1, 1, 1, 1] },
];
const validRgb = (): Buffer => file(header({ width: 2, height: 2 }), idat(rawOf(UP_ROWS)), iend());

function paeth(left: number, up: number, upLeft: number): number {
  const guess = left + up - upLeft;
  const dl = Math.abs(guess - left);
  const du = Math.abs(guess - up);
  const dul = Math.abs(guess - upLeft);
  return dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
}

describe('decodePng: what it reads', () => {
  test('an 8-bit RGB image with the Up filter', () => {
    const image = decodePng(validRgb());
    assert.equal(image.width, 2);
    assert.equal(image.height, 2);
    assert.equal(image.channels, 3);
    assert.deepEqual([...image.pixels], [10, 20, 30, 40, 50, 60, 11, 21, 31, 41, 51, 61]);
  });

  test('an 8-bit RGBA image keeps the alpha samples', () => {
    const rows: Row[] = [{ filter: 0, bytes: [1, 2, 3, 255, 4, 5, 6, 128] }];
    const image = decodePng(file(header({ width: 2, height: 1, colourType: 6 }), idat(rawOf(rows)), iend()));
    assert.equal(image.channels, 4);
    assert.deepEqual(pixelAt(image, 0, 0), [1, 2, 3, 255]);
    assert.deepEqual(pixelAt(image, 1, 0), [4, 5, 6, 128]);
  });

  test('all five row filters, Paeth included, give back the original pixels', () => {
    const width = 4;
    const channels = 3;
    const stride = width * channels;
    const original: number[][] = [];
    for (let y = 0; y < 5; y += 1) {
      original.push(Array.from({ length: stride }, (_, i) => (i * 37 + y * 91 + (i % channels) * 13) % 256));
    }
    const rows: Row[] = original.map((line, y) => ({
      filter: y,
      bytes: line.map((value, i) => {
        const left = i >= channels ? (line[i - channels] as number) : 0;
        const up = y > 0 ? ((original[y - 1] as number[])[i] as number) : 0;
        const upLeft = y > 0 && i >= channels ? ((original[y - 1] as number[])[i - channels] as number) : 0;
        const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][y] as number;
        return (value - predicted) & 0xff;
      }),
    }));
    const image = decodePng(file(header({ width, height: 5 }), idat(rawOf(rows)), iend()));
    assert.deepEqual([...image.pixels], original.flat());
  });

  test('the pixel data may be split over several consecutive IDAT chunks', () => {
    const deflated = zlib.deflateSync(rawOf(UP_ROWS));
    const half = Math.floor(deflated.length / 2);
    const image = decodePng(
      file(header({ width: 2, height: 2 }), chunk('IDAT', deflated.subarray(0, half)), chunk('IDAT', deflated.subarray(half)), iend()),
    );
    assert.deepEqual([...image.pixels.subarray(6)], [11, 21, 31, 41, 51, 61]);
  });
});

describe('decodePng: what it refuses', () => {
  test('a wrong signature', () => {
    const wrong = validRgb();
    wrong[1] = 0x51;
    assert.throws(() => decodePng(wrong), /signature/);
  });

  for (const [colourType, name] of [[0, 'grey'], [3, 'palette'], [4, 'grey and alpha']] as const) {
    test(`colour type ${colourType} (${name})`, () => {
      const bytes = file(header({ width: 2, height: 2, colourType }), idat(rawOf(UP_ROWS)), iend());
      assert.throws(() => decodePng(bytes), /colour type/);
    });
  }

  test('a bit depth of 16', () => {
    assert.throws(() => decodePng(file(header({ width: 2, height: 2, bitDepth: 16 }), idat(rawOf(UP_ROWS)), iend())), /bit depth/);
  });

  test('an interlaced image', () => {
    assert.throws(() => decodePng(file(header({ width: 2, height: 2, interlace: 1 }), idat(rawOf(UP_ROWS)), iend())), /interlace/);
  });

  test('a pixel stream one byte short', () => {
    const raw = rawOf(UP_ROWS);
    assert.throws(() => decodePng(file(header({ width: 2, height: 2 }), idat(raw.subarray(0, raw.length - 1)), iend())), /pixel data/);
  });

  test('a pixel stream one byte long, and one far too long', () => {
    for (const extra of [1, 100]) {
      const raw = Buffer.concat([rawOf(UP_ROWS), Buffer.alloc(extra)]);
      assert.throws(() => decodePng(file(header({ width: 2, height: 2 }), idat(raw), iend())), /pixel data/);
    }
  });

  test('a row filter of 5', () => {
    const rows: Row[] = [{ filter: 5, bytes: [1, 2, 3, 4, 5, 6] }, UP_ROWS[1] as Row];
    assert.throws(() => decodePng(file(header({ width: 2, height: 2 }), idat(rawOf(rows)), iend())), /filter type 5/);
  });

  test('a chunk with a bad CRC', () => {
    const bytes = file(header({ width: 2, height: 2 }), chunk('IDAT', zlib.deflateSync(rawOf(UP_ROWS)), 1), iend());
    assert.throws(() => decodePng(bytes), /checksum/);
  });

  test('a file cut inside a chunk, and one cut inside a chunk header', () => {
    const bytes = validRgb();
    assert.throws(() => decodePng(bytes.subarray(0, bytes.length - 20)), /corrupt PNG/);
    assert.throws(() => decodePng(bytes.subarray(0, SIGNATURE.length + 5)), /corrupt PNG/);
  });

  test('a file without IEND', () => {
    assert.throws(() => decodePng(file(header({ width: 2, height: 2 }), idat(rawOf(UP_ROWS)))), /IEND/);
  });

  test('bytes after IEND', () => {
    assert.throws(() => decodePng(Buffer.concat([validRgb(), Buffer.from([0])])), /after IEND/);
  });

  test('no IDAT chunk', () => {
    assert.throws(() => decodePng(file(header({ width: 2, height: 2 }), iend())), /no IDAT/);
  });

  test('IDAT chunks that are not consecutive', () => {
    const deflated = zlib.deflateSync(rawOf(UP_ROWS));
    const half = Math.floor(deflated.length / 2);
    const bytes = file(
      header({ width: 2, height: 2 }),
      chunk('IDAT', deflated.subarray(0, half)),
      chunk('tEXt', Buffer.from('k\0v')),
      chunk('IDAT', deflated.subarray(half)),
      iend(),
    );
    assert.throws(() => decodePng(bytes), /consecutive/);
  });

  test('an IHDR that is not the first chunk', () => {
    const bytes = file(chunk('tEXt', Buffer.from('k\0v')), header({ width: 2, height: 2 }), idat(rawOf(UP_ROWS)), iend());
    assert.throws(() => decodePng(bytes), /IHDR must be the first/);
  });

  test('a width or a height of 0', () => {
    assert.throws(() => decodePng(file(header({ width: 0, height: 2 }), idat(Buffer.alloc(0)), iend())), /size/);
    assert.throws(() => decodePng(file(header({ width: 2, height: 0 }), idat(Buffer.alloc(0)), iend())), /size/);
  });
});

describe('pixelAt and the mask colour', () => {
  const image = decodePng(validRgb());

  test('pixelAt reads inside the image and gives alpha 255 for RGB', () => {
    assert.deepEqual(pixelAt(image, 1, 1), [41, 51, 61, 255]);
  });

  test('pixelAt throws a RangeError outside the image', () => {
    for (const [x, y] of [[2, 0], [0, 2], [-1, 0], [0, -1]] as const) {
      assert.throws(() => pixelAt(image, x, y), RangeError);
    }
  });

  test('a translucent mask colour is not the mask colour', () => {
    const rows: Row[] = [{ filter: 0, bytes: [255, 0, 255, 255, 255, 0, 255, 128] }];
    const rgba = decodePng(file(header({ width: 2, height: 1, colourType: 6 }), idat(rawOf(rows)), iend()));
    assert.equal(countColour(rgba, MAGENTA), 1);
    assert.equal(countNotColour(rgba, { x0: 0, y0: 0, x1: 2, y1: 1 }, MAGENTA), 1);
  });

  test('countColour counts the pixels of one colour over the whole image', () => {
    const rows: Row[] = [
      { filter: 0, bytes: [255, 0, 255, 1, 2, 3] },
      { filter: 0, bytes: [255, 0, 255, 255, 0, 255] },
    ];
    const magenta = decodePng(file(header({ width: 2, height: 2 }), idat(rawOf(rows)), iend()));
    assert.equal(countColour(magenta, MAGENTA), 3);
    assert.equal(countColour(magenta, [1, 2, 3]), 1);
    assert.equal(countColour(magenta, [9, 9, 9]), 0);
  });

  test('countNotColour counts the pixels of an area that differ', () => {
    assert.equal(countNotColour(image, { x0: 0, y0: 0, x1: 2, y1: 2 }, MAGENTA), 4);
    assert.equal(countNotColour(image, { x0: 1, y0: 1, x1: 2, y1: 2 }, [41, 51, 61]), 0);
  });

  test('countNotColour throws for an area outside the image and for an empty area', () => {
    assert.throws(() => countNotColour(image, { x0: 0, y0: 0, x1: 5, y1: 5 }, MAGENTA), RangeError);
    assert.throws(() => countNotColour(image, { x0: 1, y0: 1, x1: 1, y1: 2 }, MAGENTA), RangeError);
  });
});

describe('maskCheckArea', () => {
  test('the box of the password field at scale 1 is shrunk by 2 pixels and rounded inwards', () => {
    assert.deepEqual(maskCheckArea({ x: 320, y: 239.875, width: 640, height: 31 }, 1), { x0: 322, y0: 242, x1: 958, y1: 268 });
  });

  test('at scale 2 the margin is taken in CSS pixels first, then scaled', () => {
    assert.deepEqual(maskCheckArea({ x: 320.5, y: 239.875, width: 640, height: 31 }, 2), { x0: 645, y0: 484, x1: 1917, y1: 537 });
  });

  test('a margin of 0 keeps the whole box', () => {
    assert.deepEqual(maskCheckArea({ x: 10, y: 20, width: 30, height: 40 }, 1, 0), { x0: 10, y0: 20, x1: 40, y1: 60 });
  });

  test('a box narrower than twice the margin throws instead of giving an empty area', () => {
    assert.throws(() => maskCheckArea({ x: 10, y: 10, width: 4, height: 40 }, 1), RangeError);
    assert.throws(() => maskCheckArea({ x: 10, y: 10, width: 40, height: 3 }, 2), RangeError);
  });
});
