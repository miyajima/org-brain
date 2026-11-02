import {describe,expect,it} from 'vitest';
import {createTaskSchema,leaseAcquireSchema} from '../src/schemas';
import {CAPABILITIES} from '../src/constants';

describe('optional task and lease input compatibility',()=>{
  it('does not synthesize an authenticated tenant or task metadata when omitted',()=>{
    const input={capability:CAPABILITIES[0],input_ref:'synthetic-fixture'};
    expect(createTaskSchema.parse(input)).toEqual(input);
  });
  it('retains explicitly supplied task metadata',()=>{
    const input={capability:CAPABILITIES[0],input_ref:'synthetic-fixture',tenant_id:'tenant-fixture',priority:7,
      measurement_unit:'session',measurement_reference_model:'model-fixture'};
    expect(createTaskSchema.parse(input)).toEqual(input);
  });
  it('leaves the lease duration absent for the caller to resolve',()=>{
    expect(leaseAcquireSchema.parse({task_id:'task-fixture'})).toEqual({task_id:'task-fixture'});
  });
  it('retains validation of explicit lease duration boundaries',()=>{
    for(const ttl_ms of [1000,60*60*1000])expect(leaseAcquireSchema.parse({task_id:'task-fixture',ttl_ms})).toEqual({task_id:'task-fixture',ttl_ms});
    for(const ttl_ms of [999,60*60*1000+1])expect(leaseAcquireSchema.safeParse({task_id:'task-fixture',ttl_ms}).success).toBe(false);
  });
});
