// Tests for test/helpers/zip.ts: the reader of the zip that Playwright's html reporter embeds in
// index.html. The archives are built here by hand, one stored entry and one deflated entry.
// Run: node --test test/zip.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { embeddedZipTexts, unzipTexts } from './helpers/zip.ts';

type Entry = { name: string; text: string; deflate: boolean };

function buildZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const plain = Buffer.from(entry.text);
    const data = entry.deflate ? zlib.deflateRawSync(plain) : plain;
    const method = entry.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(plain.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const ENTRIES: Entry[] = [
  { name: 'report.json', text: '{"title":"Fill \\"value\\""}', deflate: true },
  { name: 'note.md', text: 'stored as is', deflate: false },
];

describe('unzipTexts', () => {
  test('reads stored and deflated entries', () => {
    assert.deepEqual(unzipTexts(buildZip(ENTRIES)), [
      ['report.json', '{"title":"Fill \\"value\\""}'],
      ['note.md', 'stored as is'],
    ]);
  });

  test('refuses data that is not a zip archive', () => {
    assert.throws(() => unzipTexts(Buffer.from('not a zip archive at all, only text')), /not a zip archive/);
  });
});

describe('embeddedZipTexts', () => {
  test('finds the base64 archive inside an html document', () => {
    const base64 = buildZip(ENTRIES).toString('base64');
    const html = `<script>window.report = "data:application/zip;base64,${base64}";</script>`;
    assert.deepEqual(
      embeddedZipTexts(html).map(([name]) => name),
      ['report.json', 'note.md'],
    );
  });

  test('returns nothing for a document without an archive', () => {
    assert.deepEqual(embeddedZipTexts('<html></html>'), []);
  });
});
