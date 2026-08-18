import type { ExecutionLog, RecordingScenario } from './scenario-runner.js';

export interface SubtitleEntry {
  startTime: number;
  endTime: number;
  text: string;
}

export interface SubtitleOptions {
  minDurationMs?: number;
  endPaddingMs?: number;
  maxCharsPerLine?: number;
}

export class SubtitleGenerator {
  generateFromExecutionLogs(
    scenario: RecordingScenario,
    executionLogs: ExecutionLog[],
    options: SubtitleOptions = {}
  ): SubtitleEntry[] {
    const minDurationSec = (options.minDurationMs ?? 1400) / 1000;
    const endPaddingSec = (options.endPaddingMs ?? 550) / 1000;
    const maxCharsPerLine = options.maxCharsPerLine ?? 24;
    const mediaStartMs = executionLogs.length > 0 ? Date.parse(executionLogs[0].start_time) : Date.now();

    const entries = scenario.steps.flatMap((step, index) => {
      const log = executionLogs.find((entry) => entry.step_index === index);
      const text = this.wrapSubtitleText(step.subtitle ?? '', maxCharsPerLine);

      if (!log || !text) {
        return [];
      }

      const startMs = Math.max(0, Date.parse(log.start_time) - mediaStartMs);
      const endMs = Math.max(startMs, Date.parse(log.end_time) - mediaStartMs);

      return [
        {
          startTime: startMs / 1000,
          endTime: Math.max(endMs / 1000 + endPaddingSec, startMs / 1000 + minDurationSec),
          text,
        },
      ];
    });

    return this.preventOverlaps(entries);
  }

  toVtt(entries: SubtitleEntry[]): string {
    const body = entries
      .map((entry) => `${this.formatVttTime(entry.startTime)} --> ${this.formatVttTime(entry.endTime)}\n${entry.text}\n`)
      .join('\n');

    return `WEBVTT\n\n${body}`;
  }

  private formatVttTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    const ms = Math.floor((secs % 1) * 1000);

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(Math.floor(secs)).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }

  private wrapSubtitleText(text: string, maxCharsPerLine: number): string {
    const trimmed = text.trim();
    if (!trimmed) {
      return '';
    }

    const lines: string[] = [];
    let currentLine = '';

    for (const char of [...trimmed]) {
      currentLine += char;
      if ([...currentLine].length >= maxCharsPerLine) {
        lines.push(currentLine.trim());
        currentLine = '';
      }
    }

    if (currentLine.trim()) {
      lines.push(currentLine.trim());
    }

    return lines.join('\n');
  }

  private preventOverlaps(entries: SubtitleEntry[]): SubtitleEntry[] {
    return entries.map((entry, index) => {
      const nextEntry = entries[index + 1];
      if (!nextEntry) {
        return entry;
      }

      const safeEnd = nextEntry.startTime - 0.05;
      if (safeEnd <= entry.startTime) {
        return { ...entry, endTime: entry.startTime + 0.2 };
      }

      return { ...entry, endTime: Math.min(entry.endTime, safeEnd) };
    });
  }
}
