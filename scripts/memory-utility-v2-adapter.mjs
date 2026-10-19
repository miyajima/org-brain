import {verifiedCandidates} from '../packages/shared/src/memory-extraction-verifier-runtime.mjs';

// This adapter intentionally uses the current shared verifier. Its source and
// transitive shared dependencies are bound by each experiment's code manifest.
export async function currentSharedV2Candidates(input,candidates){
  if(input?.packet?.schema!=='learning-extraction-proposal/v2')throw Error('v2_packet_required');
  return verifiedCandidates(input,candidates);
}
