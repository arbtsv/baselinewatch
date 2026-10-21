// Tests for test/helpers/zip.ts: the reader of the zip that Playwright's html reporter embeds in
// index.html. The archives are built here by hand, one stored entry and one deflated entry.
// Run: node --test test/zip.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { embeddedZipTexts, unzipTexts } from './helpers/zip.ts';

type Entry = {
  name: string;
  text: string;
  deflate: boolean;
  /** Bytes of local extra field, which the central directory does not repeat. */
  localExtra?: number;
  /** Writes the sizes into a data descriptor and zero into the local header. */
  descriptor?: boolean;
  /** Overrides the compression method. */
  method?: number;
};

function buildZip(entries: Entry[], comment = ''): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const plain = Buffer.from(entry.text);
    const data = entry.deflate ? zlib.deflateRawSync(plain) : plain;
    const method = entry.method ?? (entry.deflate ? 8 : 0);
    const extra = Buffer.alloc(entry.localExtra ?? 0, 0x61);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(entry.descriptor === true ? 8 : 0, 6);
    local.writeUInt16LE(method, 8);
    if (entry.descriptor !== true) {
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(plain.length, 22);
    }
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const descriptor = Buffer.alloc(entry.descriptor === true ? 16 : 0);
    if (entry.descriptor === true) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(data.length, 8);
      descriptor.writeUInt32LE(plain.length, 12);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(plain.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, extra, data, descriptor);
    centrals.push(central, name);
    offset += local.length + name.length + extra.length + data.length + descriptor.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, directory, end, Buffer.from(comment)]);
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

  test('reads an entry with a local extra field and one with a data descriptor', () => {
    const entries: Entry[] = [
      { name: 'a.txt', text: 'extra field', deflate: true, localExtra: 11 },
      { name: 'b.txt', text: 'descriptor', deflate: true, descriptor: true },
    ];
    assert.deepEqual(unzipTexts(buildZip(entries)), [
      ['a.txt', 'extra field'],
      ['b.txt', 'descriptor'],
    ]);
  });

  test('reads an empty entry and an archive that ends with a comment', () => {
    const entries: Entry[] = [{ name: 'empty.txt', text: '', deflate: false }];
    assert.deepEqual(unzipTexts(buildZip(entries, 'a comment')), [['empty.txt', '']]);
  });

  test('refuses a compression method other than stored or deflate', () => {
    const archive = buildZip([{ name: 'x.txt', text: 'x', deflate: false, method: 12 }]);
    assert.throws(() => unzipTexts(archive), /compression method 12/);
  });

  test('refuses a damaged central header', () => {
    const archive = buildZip(ENTRIES);
    archive.writeUInt32LE(0, archive.readUInt32LE(archive.length - 22 + 16));
    assert.throws(() => unzipTexts(archive), /bad central header/);
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
