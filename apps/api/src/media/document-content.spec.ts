import { deflateRawSync } from 'node:zlib';
import { DOCUMENT_FORMAT_BY_MIME } from './attachment-formats';
import { validDocumentContent } from './document-content';

function officeZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const filename = Buffer.from(name);
    const bytes = Buffer.from(content);
    const packed = deflateRawSync(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, packed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(packed.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += local.length + filename.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe('Document content validation', () => {
  it('accepts PDF signatures and valid UTF-8 text, rejecting disguised binary', () => {
    expect(
      validDocumentContent(
        Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n'),
        'application/pdf',
      ),
    ).toBe(true);
    expect(
      validDocumentContent(Buffer.from('Class notes ✨\n'), 'text/plain'),
    ).toBe(true);
    for (const bytes of [
      Buffer.from('<script>alert(1)</script>'),
      Buffer.from('MZ binary'),
      Buffer.from('%PDF-1.7 truncated'),
    ])
      expect(validDocumentContent(bytes, 'application/pdf')).toBe(false);
    for (const bytes of [
      Buffer.from([0xff, 0xfe]),
      Buffer.from('binary\0data'),
      Buffer.alloc(0),
    ])
      expect(validDocumentContent(bytes, 'text/plain')).toBe(false);
  });

  it.each([
    ['docx', 'word/document.xml', 'wordprocessingml.document.main+xml'],
    ['xlsx', 'xl/workbook.xml', 'spreadsheetml.sheet.main+xml'],
    ['pptx', 'ppt/presentation.xml', 'presentationml.presentation.main+xml'],
  ])(
    'accepts bounded %s containers and rejects mismatched/active/malformed archives',
    (format, main, contentType) => {
      const mime = Object.entries(DOCUMENT_FORMAT_BY_MIME).find(
        ([, value]) => value === format,
      )![0];
      const entries = {
        '[Content_Types].xml': `<Types><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${contentType}"/></Types>`,
        '_rels/.rels': '<Relationships/>',
        [main]: '<document/>',
      };
      const valid = officeZip(entries);
      expect(validDocumentContent(valid, mime)).toBe(true);
      expect(validDocumentContent(valid, 'application/pdf')).toBe(false);
      expect(validDocumentContent(valid.subarray(0, -5), mime)).toBe(false);
      expect(
        validDocumentContent(
          officeZip({ ...entries, '../outside': 'x' }),
          mime,
        ),
      ).toBe(false);
      expect(
        validDocumentContent(
          officeZip({ ...entries, 'word/vbaProject.bin': 'macro' }),
          mime,
        ),
      ).toBe(false);
      expect(
        validDocumentContent(
          officeZip({
            ...entries,
            '[Content_Types].xml': '<!DOCTYPE x>macroEnabled',
          }),
          mime,
        ),
      ).toBe(false);
      expect(
        validDocumentContent(
          officeZip({ ...entries, [main]: 'x'.repeat(8 * 1024 * 1024 + 1) }),
          mime,
        ),
      ).toBe(false);
      const encrypted = Buffer.from(valid);
      const central = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      encrypted.writeUInt16LE(1, central + 8);
      expect(validDocumentContent(encrypted, mime)).toBe(false);
    },
  );
});
