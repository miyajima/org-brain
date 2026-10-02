import assert from 'node:assert/strict';
import test from 'node:test';
import { extractDurableMemoryDrafts } from '../packages/shared/src/memory-capture-v2-runtime.mjs';
import { MEMORY_CAPTURE_HOOK_PROFILE } from '../packages/shared/src/memory-capture-profile.generated.mjs';
import { assessLessonCapture, lessonCaptureCases } from './fixtures/memory-lesson-capture.mjs';

for (const fixture of lessonCaptureCases) {
  test(`atomic lesson capture: ${fixture.id}`, () => {
    const result = assessLessonCapture(extractDurableMemoryDrafts, MEMORY_CAPTURE_HOOK_PROFILE, fixture);
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(result.command_evidence_count, 0, 'prose never attests command execution');
  });
}
