import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { logger } from './logger.js';

/**
 * Convert an audio file to WAV (16kHz mono) using macOS afconvert.
 * whisper.cpp server reads WAV natively without requiring ffmpeg.
 * Returns the path to the converted WAV, or null if conversion fails.
 */
function toWav(filePath: string): string | null {
  const wavPath = path.join(os.tmpdir(), `whisper-${Date.now()}.wav`);
  try {
    execSync(`afconvert -f WAVE -d LEI16 ${JSON.stringify(filePath)} ${JSON.stringify(wavPath)}`, {
      timeout: 30000,
    });
    return wavPath;
  } catch (err) {
    logger.warn({ filePath, err }, 'afconvert failed');
    return null;
  }
}

/**
 * Transcribe an audio file by POSTing it to a whisper.cpp-compatible
 * /v1/audio/transcriptions endpoint.
 *
 * Converts audio to WAV first using macOS afconvert (whisper.cpp reads
 * WAV natively without ffmpeg). Returns the transcript string (may be
 * empty if no speech detected), or null on any error.
 */
export async function transcribeAudio(
  filePath: string,
  apiUrl: string,
): Promise<string | null> {
  // afconvert needs the correct extension to detect format — rename if needed
  let inputPath = filePath;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.aac') {
    // Signal iOS voice notes: M4A container saved with .aac extension
    const m4aPath = filePath.replace(/\.aac$/, '.m4a');
    try {
      fs.copyFileSync(filePath, m4aPath);
      inputPath = m4aPath;
    } catch {
      // fallback to original path
    }
  }

  const wavPath = toWav(inputPath);
  if (!wavPath) return null;

  try {
    const audioBuffer = fs.readFileSync(wavPath);
    logger.info({ filePath, size: audioBuffer.length, apiUrl }, 'Transcribing audio');

    const form = new FormData();
    form.append('file', new Blob([audioBuffer]), 'audio.wav');
    form.append('model', 'whisper-1');

    const res = await fetch(`${apiUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      body: form,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn({ status: res.status, body }, 'Whisper API returned non-ok response');
      return null;
    }

    const data = await res.json() as { text?: string };
    logger.info({ transcript: data.text }, 'Whisper transcription result');
    return data.text?.trim() ?? null;
  } catch (err) {
    logger.warn({ err }, 'Whisper transcription failed');
    return null;
  } finally {
    fs.unlink(wavPath, () => {});
    if (inputPath !== filePath) fs.unlink(inputPath, () => {});
  }
}
