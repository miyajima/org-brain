import test from 'node:test';
import assert from 'node:assert/strict';

import {JSON_ANGLE_ESCAPE_INSTRUCTION, serializeV12Payload} from './memory-utility-v12.mjs';
import {jobPrompt, qualityOutput, RESERVED_TAG, syntheticCase} from './memory-utility-v12-smoke.mjs';

test('public v1.2 smoke construction preserves the reserved tag across transport fields', () => {
  const {source, target, item} = syntheticCase();
  assert.equal(source.target[0].text.includes(RESERVED_TAG), true);
  assert.equal(target[0].text.includes(RESERVED_TAG), true);
  assert.equal(item.content, 'Synthetic summary.');
  assert.equal(item.content.includes(RESERVED_TAG), false);
  assert.deepEqual(item.evidence.content, [{id: 'span-1'}]);

  const quality = qualityOutput(target, item.id);
  assert.deepEqual(quality.checked_set.find(span => span.id === 'span-1'), {id: 'span-1'});

  const prompt = jobPrompt({target, expected_output: {items: [item]}});
  assert.equal(prompt.includes(JSON_ANGLE_ESCAPE_INSTRUCTION), true);
  assert.equal(prompt.includes('\\u003coai-mem-citation\\u003e'), true);
  assert.equal(prompt.includes(RESERVED_TAG), false);
});

test('v1.2 payload serialization preserves tags, backslashes, and control-like input', () => {
  const payload = {
    paired_tag: RESERVED_TAG,
    literal_backslashes: String.raw`\\u003c \\u003e \\u0003c`,
    control_like: '\u0003c'
  };
  const serialized = serializeV12Payload(payload);
  assert.equal(serialized.includes('\\u003coai-mem-citation\\u003epublic synthetic fixture\\u003c/oai-mem-citation\\u003e'), true);
  assert.deepEqual(JSON.parse(serialized), payload);
});
