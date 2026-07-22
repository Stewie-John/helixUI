import fs from 'node:fs';

export const DEFAULT_MAX_JSONL_RECORD_BYTES = 4 * 1024 * 1024;

export async function* readBoundedJsonlLines(
  filePath,
  maxRecordBytes = DEFAULT_MAX_JSONL_RECORD_BYTES,
) {
  const stream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
  let parts = [];
  let length = 0;
  let droppingOversizedRecord = false;

  const append = (part) => {
    if (droppingOversizedRecord || part.length === 0) return;
    length += part.length;
    if (length > maxRecordBytes) {
      parts = [];
      length = 0;
      droppingOversizedRecord = true;
      return;
    }
    parts.push(part);
  };

  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      if (newline === -1) {
        append(chunk.subarray(start));
        break;
      }
      append(chunk.subarray(start, newline));
      if (!droppingOversizedRecord) {
        yield Buffer.concat(parts, length).toString('utf8').replace(/\r$/, '');
      }
      parts = [];
      length = 0;
      droppingOversizedRecord = false;
      start = newline + 1;
    }
  }

  if (!droppingOversizedRecord && length > 0) {
    yield Buffer.concat(parts, length).toString('utf8').replace(/\r$/, '');
  }
}
