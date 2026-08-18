import { execFile as execFileCallback } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export async function transcodeToMp4(recordingPath: string, outputMp4Path: string): Promise<void> {
  await execFile('ffmpeg', [
    '-y',
    '-i',
    recordingPath,
    '-c:v',
    'libx264',
    '-crf',
    '21',
    '-preset',
    'medium',
    '-pix_fmt',
    'yuv420p',
    outputMp4Path,
  ]);
}

export async function createThumbnail(inputPath: string, outputPath: string, seconds: number): Promise<void> {
  await execFile('ffmpeg', ['-y', '-ss', String(seconds), '-i', inputPath, '-frames:v', '1', outputPath]);
}

export async function createPlayerHtml(params: {
  title: string;
  description: string;
  outputDir: string;
  webmPath: string;
  mp4Path?: string;
  subtitlePath?: string;
  loadSubtitleTrack?: boolean;
}): Promise<string> {
  const playerPath = path.join(params.outputDir, 'player.html');
  const shouldLoadSubtitleTrack = Boolean(params.subtitlePath) && params.loadSubtitleTrack !== false;
  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(params.title)}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111827; color: #f9fafb; font-family: system-ui, sans-serif; }
    main { width: min(1100px, 96vw); }
    h1 { margin: 0 0 12px; font-size: 20px; }
    p { margin: 0 0 18px; color: #d1d5db; font-size: 14px; }
    video { width: 100%; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,.35); background: #000; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(params.title)}</h1>
    <p>${escapeHtml(params.description)}</p>
    <video controls preload="metadata">
      ${params.mp4Path ? `<source src="./${path.basename(params.mp4Path)}" type="video/mp4">` : ''}
      <source src="./${path.basename(params.webmPath)}" type="video/webm">
      ${shouldLoadSubtitleTrack ? `<track default kind="subtitles" label="Japanese" src="./${path.basename(params.subtitlePath!)}" srclang="ja">` : ''}
    </video>
  </main>
</body>
</html>`;

  await fs.writeFile(playerPath, html, 'utf8');
  return playerPath;
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
