import fs from 'fs';

/**
 * Detect actual image content type from magic bytes.
 * Signal sometimes reports the wrong MIME type (e.g. image/png for JPEG files).
 * Reading magic bytes is authoritative.
 */
export function detectImageContentType(filePath: string, declared: string): string {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
    if (
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    ) return 'image/webp';
  } catch {
    // file unreadable — fall through to declared type
  }
  return declared;
}
