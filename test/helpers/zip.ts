// A reader for the zips the e2e tests meet: the one Playwright's html reporter embeds in index.html as
// base64, and the run zip that tar.exe writes. It reads the central directory and supports stored and
// deflated entries, which is all either of them holds.
import zlib from 'node:zlib';

const END_OF_DIRECTORY = 0x06054b50;
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;
const DATA_URI = /data:application\/zip;base64,([A-Za-z0-9+/=]+)/g;

/**
 * The bytes of every entry of a zip archive, keyed by entry name. An archive this reader does not
 * understand (zip64, a compression method other than stored or deflate, a damaged header) is an
 * error: reading it wrongly would make a secret check pass for the wrong reason.
 */
export function unzipEntries(archive: Buffer): [string, Buffer][] {
  let end = archive.length - 22;
  while (end >= 0 && archive.readUInt32LE(end) !== END_OF_DIRECTORY) end -= 1;
  if (end < 0) throw new Error('not a zip archive: no end of central directory');
  const count = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  if (count === 0xffff || cursor === ZIP64_MARKER) throw new Error('unsupported zip archive: zip64');
  const entries: [string, Buffer][] = [];
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(cursor) !== CENTRAL_HEADER) throw new Error('damaged zip archive: bad central header');
    const method = archive.readUInt16LE(cursor + 10);
    if (method !== 0 && method !== 8) throw new Error(`unsupported zip archive: compression method ${method}`);
    const size = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const offset = archive.readUInt32LE(cursor + 42);
    if (size === ZIP64_MARKER || offset === ZIP64_MARKER) throw new Error('unsupported zip archive: zip64');
    if (archive.readUInt32LE(offset) !== LOCAL_HEADER) throw new Error('damaged zip archive: bad local header');
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const dataStart = offset + 30 + archive.readUInt16LE(offset + 26) + archive.readUInt16LE(offset + 28);
    const raw = archive.subarray(dataStart, dataStart + size);
    entries.push([name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw)]);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The text of every entry of a zip archive, keyed by entry name; see unzipEntries. */
export function unzipTexts(archive: Buffer): [string, string][] {
  return unzipEntries(archive).map(([name, bytes]): [string, string] => [name, bytes.toString('utf8')]);
}

/** The entries of every base64 zip embedded in an html document. */
export function embeddedZipTexts(html: string): [string, string][] {
  const entries: [string, string][] = [];
  for (const match of html.matchAll(DATA_URI)) {
    entries.push(...unzipTexts(Buffer.from(match[1] as string, 'base64')));
  }
  return entries;
}
