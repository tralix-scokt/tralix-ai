import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ExtractedFrames {
  frames: { buffer: Buffer; timestampSeconds: number }[];
  note: string;
}

export async function isFfmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract sampled frames from video buffer using ffmpeg.
 * Samples up to maxFrames (e.g. 4 frames) evenly spaced across the video.
 */
export async function extractVideoFrames(videoBuffer: Buffer, maxFrames = 4): Promise<ExtractedFrames> {
  const available = await isFfmpegAvailable();
  if (!available) {
    throw new Error('ffmpeg is not installed on this server to extract video frames.');
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tralix-vid-'));
  const inputPath = path.join(tempDir, 'input.mp4');

  try {
    await fs.promises.writeFile(inputPath, videoBuffer);

    // Get video duration via ffprobe or ffmpeg
    let durationSeconds = 10;
    try {
      const { stderr } = await execFileAsync('ffmpeg', ['-i', inputPath], { maxBuffer: 10 * 1024 * 1024 });
      const durationMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
      if (durationMatch) {
        const hours = Number.parseFloat(durationMatch[1]);
        const mins = Number.parseFloat(durationMatch[2]);
        const secs = Number.parseFloat(durationMatch[3]);
        durationSeconds = hours * 3600 + mins * 60 + secs;
      }
    } catch {
      // ffmpeg exits with code 1 when invoked with only -i without output, but outputs metadata in stderr
    }

    const interval = Math.max(1, Math.floor(durationSeconds / (maxFrames + 1)));
    const frames: { buffer: Buffer; timestampSeconds: number }[] = [];

    for (let i = 1; i <= maxFrames; i++) {
      const timestamp = Math.min(durationSeconds - 0.5, i * interval);
      const outPath = path.join(tempDir, `frame_${i}.jpg`);
      try {
        await execFileAsync('ffmpeg', [
          '-ss',
          timestamp.toString(),
          '-i',
          inputPath,
          '-vframes',
          '1',
          '-q:v',
          '3',
          '-vf',
          'scale=1024:-1',
          '-y',
          outPath,
        ]);
        if (fs.existsSync(outPath)) {
          const buf = await fs.promises.readFile(outPath);
          frames.push({ buffer: buf, timestampSeconds: Math.round(timestamp) });
        }
      } catch (err) {
        console.warn(`[video] failed to extract frame at ${timestamp}s:`, (err as Error)?.message);
      }
    }

    if (!frames.length) {
      // Fallback: extract the very first frame
      const firstPath = path.join(tempDir, 'frame_first.jpg');
      await execFileAsync('ffmpeg', ['-i', inputPath, '-vframes', '1', '-q:v', '3', '-y', firstPath]);
      if (fs.existsSync(firstPath)) {
        frames.push({ buffer: await fs.promises.readFile(firstPath), timestampSeconds: 0 });
      }
    }

    const timestampsText = frames.map((f) => `${f.timestampSeconds}s`).join(', ');
    const note = `Analysed from ${frames.length} sampled frame${frames.length === 1 ? '' : 's'} (${timestampsText}).`;

    return { frames, note };
  } finally {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
