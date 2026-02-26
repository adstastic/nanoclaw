import fs from 'node:fs';
import path from 'node:path';

/**
 * Transcribe an audio file by POSTing it to a whisper.cpp-compatible
 * /v1/audio/transcriptions endpoint.
 *
 * Returns the transcript string (may be empty if no speech detected),
 * or null on any error (server down, network failure, bad response).
 */
export async function transcribeAudio(
  filePath: string,
  apiUrl: string,
): Promise<string | null> {
  try {
    const audioBuffer = fs.readFileSync(filePath);
    const filename = path.basename(filePath);

    const form = new FormData();
    form.append('file', new Blob([audioBuffer]), filename);
    form.append('model', 'whisper-1');

    const res = await fetch(`${apiUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      body: form,
    });

    if (!res.ok) return null;

    const data = await res.json() as { text?: string };
    return data.text?.trim() ?? null;
  } catch {
    return null;
  }
}
