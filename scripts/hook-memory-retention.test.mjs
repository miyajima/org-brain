import {describe,it,expect} from 'vitest';
import {prepareMemoryRecordsV2, normalizeRecord, captureItemPayload} from '../packages/orgbrain-cli/src/hook-memory-bridge.mjs';

describe('reported verification retention',()=>{
  it('serializes a reported result separately from verified execution evidence',async()=>{
    const record=normalizeRecord('codex-stop',JSON.stringify({hook_event_name:'Stop',cwd:'/tmp/orgbrain-retention',turn_id:'retention-result',
      last_assistant_message:[
        '## Conclusion','We decided to use ORGBRAIN_API_URL as the canonical variable.',
        '## Reason','This prevents configuration names from diverging across adapters.',
        '## Reuse','When a connector is added, use the canonical setting.',
        '## Evidence','docs/SPEC.md and packages/shared/src/index.ts',
        '## Result','27 tests passed; 2 skipped; production validation remains unverified.'
      ].join('\n')}));
    const result=await prepareMemoryRecordsV2(record,{workspaceRoot:'/tmp/orgbrain-retention',projectId:'org-brain',sensitiveMemory:{mode:'deny',allowed_principals:[]}},'default',{rows:[],requireFullTurn:true});
    expect(result.records).toHaveLength(1);
    const payload=captureItemPayload(result.records[0]);
    expect(payload.learning.reported_verification).toEqual({state:'unverified',text:'27 tests passed; 2 skipped; production validation remains unverified.'});
    expect(payload.verification_state).toBe('unverified');
    expect(payload.evidence.some(item=>item.evidence_type==='command')).toBe(false);
    expect(result.eagerRecords).toEqual([]);
  });
});
