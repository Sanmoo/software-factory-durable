import { crc32, deflateSync } from 'node:zlib';

// Synthetic 1x1 red fixtures generated locally using the pinned SDK's Photon
// dependency. No fetched assets. Tests add literal metadata, never decode images.
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==', 'base64');
export const jpeg = Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD/wAARCAABAAEDAREAAhEBAxEB/9sAQwAGBAUGBQQGBgUGBwcGCAoQCgoJCQoUDg8MEBcUGBgXFBYWGh0lHxobIxwWFiAsICMmJykqKRkfLTAtKDAlKCko/9sAQwEHBwcKCAoTCgoTKBoWGigoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDzqvjT+kT/2Q==', 'base64');

export function withMetadata(source: Buffer, value: Buffer): Buffer {
  if (source === png) {
    const data = Buffer.concat([Buffer.from('Comment\0'), value]);
    const chunk = Buffer.alloc(data.length + 12);
    chunk.writeUInt32BE(data.length); chunk.write('tEXt', 4); data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    return Buffer.concat([source.subarray(0, 33), chunk, source.subarray(33)]);
  }
  assertMetadataSize(value.length);
  const header = Buffer.from([255, 254, 0, 0]); header.writeUInt16BE(value.length + 2, 2);
  return Buffer.concat([source.subarray(0, 2), header, value, source.subarray(2)]);
}
function assertMetadataSize(length: number) {
  if (length > 65533) throw new Error('TEST_METADATA_LIMIT');
}

/** Locally construct a clean wide PNG to exercise actual native resize, not a
 * replacement decoder or result implementation. */
export function widePng(): Buffer {
  const width = 2101;
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6;
  const row = Buffer.alloc(1 + width * 4, 255); row[0] = 0;
  return Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(row)), pngChunk('IEND', Buffer.alloc(0))]);
}
function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12); chunk.writeUInt32BE(data.length); chunk.write(type, 4); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4); return chunk;
}
