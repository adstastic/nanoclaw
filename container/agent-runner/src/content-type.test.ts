import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectImageContentType } from './content-type.js';

function writeTmpFile(bytes: Buffer): string {
  const filePath = path.join(os.tmpdir(), `ct-test-${Date.now()}-${Math.random()}`);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

describe('detectImageContentType', () => {
  it('detects JPEG bytes even when declared as image/png', () => {
    // JPEG magic: FF D8 FF
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const file = writeTmpFile(jpegBytes);
    expect(detectImageContentType(file, 'image/png')).toBe('image/jpeg');
    fs.unlinkSync(file);
  });

  it('detects PNG bytes when declared correctly', () => {
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const file = writeTmpFile(pngBytes);
    expect(detectImageContentType(file, 'image/png')).toBe('image/png');
    fs.unlinkSync(file);
  });

  it('falls back to declared type when bytes are unrecognized', () => {
    const randomBytes = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const file = writeTmpFile(randomBytes);
    expect(detectImageContentType(file, 'image/webp')).toBe('image/webp');
    fs.unlinkSync(file);
  });

  it('falls back to declared type when file does not exist', () => {
    expect(detectImageContentType('/nonexistent/file.png', 'image/png')).toBe('image/png');
  });
});
