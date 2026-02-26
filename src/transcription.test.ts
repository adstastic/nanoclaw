import { describe, it, expect, vi, beforeEach } from 'vitest';
import { transcribeAudio } from './transcription.js';
import fs from 'node:fs';

vi.mock('node:fs');

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('transcribeAudio', () => {
  beforeEach(() => {
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-audio'));
    mockFetch.mockReset();
  });

  it('returns transcript on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: '  hello world  ' }),
    });
    const result = await transcribeAudio('/tmp/audio.ogg', 'http://localhost:2022');
    expect(result).toBe('hello world');
  });

  it('returns empty string when no speech detected', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: '' }),
    });
    const result = await transcribeAudio('/tmp/audio.ogg', 'http://localhost:2022');
    expect(result).toBe('');
  });

  it('returns null when server returns non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const result = await transcribeAudio('/tmp/audio.ogg', 'http://localhost:2022');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await transcribeAudio('/tmp/audio.ogg', 'http://localhost:2022');
    expect(result).toBeNull();
  });
});
