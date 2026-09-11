import { inflateRawSync } from 'node:zlib';
import {
  documentFormat,
  MAX_DOCUMENT_UPLOAD_BYTES,
} from './attachment-formats';

// Bounded file/container checks, NOT an antivirus scanner. Never execute macros,
// resolve XML entities, or extract archive paths onto the filesystem.
export function validDocumentContent(bytes: Buffer, mime: string): boolean {
  if (bytes.length === 0 || bytes.length > MAX_DOCUMENT_UPLOAD_BYTES)
    return false;
  const format = documentFormat(mime);
  if (format === 'pdf')
    return (
      /^%PDF-[12]\.\d/.test(bytes.subarray(0, 8).toString('ascii')) &&
      /%%EOF\s*$/.test(bytes.subarray(-1024).toString('ascii'))
    );
  if (format === 'txt') {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      // Reject binary controls while allowing ordinary UTF-8 text and line breaks.
      // eslint-disable-next-line no-control-regex
      return !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
    } catch {
      return false;
    }
  }
  if (!format || !['docx', 'xlsx', 'pptx'].includes(format)) return false;
  try {
    return validOfficeContainer(bytes, format);
  } catch {
    return false;
  }
}

function validOfficeContainer(bytes: Buffer, format: string): boolean {
  if (bytes.readUInt32LE(0) !== 0x04034b50) return false;
  let end = -1;
  for (
    let i = bytes.length - 22;
    i >= Math.max(0, bytes.length - 65557);
    i -= 1
  ) {
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  if (
    end < 0 ||
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0
  )
    return false;
  const count = bytes.readUInt16LE(end + 10);
  if (!count || count > 2048 || count !== bytes.readUInt16LE(end + 8))
    return false;
  const directorySize = bytes.readUInt32LE(end + 12);
  let cursor = bytes.readUInt32LE(end + 16);
  const directoryStart = cursor;
  if (cursor + directorySize !== end) return false;
  const names = new Set<string>();
  const ranges: Array<[number, number]> = [];
  let inflatedTotal = 0;
  let contentTypes = '';
  let mainXml = '';
  const mainPath =
    format === 'docx'
      ? 'word/document.xml'
      : format === 'xlsx'
        ? 'xl/workbook.xml'
        : 'ppt/presentation.xml';
  const mainType =
    format === 'docx'
      ? 'wordprocessingml.document.main+xml'
      : format === 'xlsx'
        ? 'spreadsheetml.sheet.main+xml'
        : 'presentationml.presentation.main+xml';
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
      return false;
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const expanded = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const entryEnd =
      cursor +
      46 +
      nameLength +
      bytes.readUInt16LE(cursor + 30) +
      bytes.readUInt16LE(cursor + 32);
    if (
      entryEnd > end ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      bytes.readUInt16LE(cursor + 34) !== 0
    )
      return false;
    const name = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    // ZIP entry names must not contain controls or unsafe filesystem paths.
    // eslint-disable-next-line no-control-regex
    const unsafeName = /[\\\x00-\x1f]/.test(name);
    if (
      !name ||
      names.has(name) ||
      unsafeName ||
      name.startsWith('/') ||
      name.split('/').includes('..') ||
      /vbaproject|activex|embeddings\/|\.(exe|dll|js|vbs|com|scr)$/i.test(name)
    )
      return false;
    names.add(name);
    inflatedTotal += expanded;
    if (
      inflatedTotal > 100 * 1024 * 1024 ||
      compressed > MAX_DOCUMENT_UPLOAD_BYTES
    )
      return false;
    const local = bytes.readUInt32LE(cursor + 42);
    if (
      local + 30 > directoryStart ||
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method
    )
      return false;
    const localNameLength = bytes.readUInt16LE(local + 26);
    const dataStart =
      local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    if (
      dataStart + compressed > directoryStart ||
      !bytes
        .subarray(local + 30, local + 30 + localNameLength)
        .equals(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    )
      return false;
    ranges.push([local, dataStart + compressed]);
    if (name === '[Content_Types].xml' || name === mainPath) {
      const limit =
        name === '[Content_Types].xml' ? 256 * 1024 : 8 * 1024 * 1024;
      if (expanded > limit) return false;
      const packed = bytes.subarray(dataStart, dataStart + compressed);
      const unpacked =
        method === 8
          ? inflateRawSync(packed, { maxOutputLength: limit })
          : packed;
      if (unpacked.length !== expanded) return false;
      const xml = new TextDecoder('utf-8', { fatal: true }).decode(unpacked);
      if (/<!DOCTYPE|<!ENTITY|macroEnabled/i.test(xml)) return false;
      if (name === mainPath) mainXml = xml;
      else contentTypes = xml;
    }
    cursor = entryEnd;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (
    ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1]![1])
  )
    return false;
  return (
    cursor === end &&
    names.has('_rels/.rels') &&
    Boolean(mainXml) &&
    contentTypes.includes(mainPath) &&
    contentTypes.includes(mainType)
  );
}
