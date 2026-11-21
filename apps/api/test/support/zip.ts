import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
  /** Uncompressed size written in the headers; defaults to the real size. A lie when smaller. */
  declaredSize?: number;
}

/** A minimal deflate ZIP archive (no data descriptors), enough to craft test workbooks. */
export function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data, declaredSize = data.length } of entries) {
    const fileName = Buffer.from(name);
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, compressed);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A small "workbook" whose worksheet XML inflates to `bytes` bytes of spaces. */
export function zipBomb(bytes: number, declaredSize?: number): Buffer {
  const sheet = Buffer.concat([
    Buffer.from('<worksheet>'),
    Buffer.alloc(bytes, ' '),
    Buffer.from('</worksheet>'),
  ]);
  return makeZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: sheet,
      ...(declaredSize === undefined ? {} : { declaredSize }),
    },
  ]);
}
