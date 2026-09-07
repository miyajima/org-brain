// Compile only the existing pure verifier, never the capability's API/DB/provider code.
import fs from 'node:fs';
import ts from 'typescript';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import {normalizeMemoryContractV2Event} from '../packages/shared/src/memory-contract-v2-runtime.mjs';
const sourcePath=new URL('../apps/cap-runner/src/capabilities/memory-extraction.ts',import.meta.url);
export const VERIFIER_FUNCTIONS=['exactGrounded','providerFields','inferredDecisionType','verifiedCandidates'];
export async function frozenV2Candidates(input,candidates){
  if(input.packet.schema!=='learning-extraction-proposal/v2')throw Error('v2_packet_required');
  const source=fs.readFileSync(sourcePath,'utf8'),tree=ts.createSourceFile('baseline.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const functions=VERIFIER_FUNCTIONS.map(name=>{
    const matches=tree.statements.filter(s=>ts.isFunctionDeclaration(s)&&s.name?.text===name);
    if(matches.length!==1)throw Error('frozen_verifier_shape_changed:'+name);
    return matches[0].getText(tree);
  });
  const constants=['MAX_CANDIDATES','DURABLE_MEMORY_KINDS'].map(name=>{
    const matches=tree.statements.filter(s=>ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>ts.isIdentifier(d.name)&&d.name.text===name));
    if(matches.length!==1||matches[0].declarationList.declarations.length!==1)throw Error('frozen_constant_shape_changed');
    return matches[0].getText(tree);
  });
  const code=ts.transpileModule('export function create(normalizeMemoryContractV2Event,sha256) { const MEMORY_EXTRACTION_MAX_CANDIDATES=3; const validateV3Candidate=()=>{throw Error("v3_not_allowed")};\n'+constants.join('\n')+'\n'+functions.join('\n')+'\nreturn verifiedCandidates;}',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022},reportDiagnostics:true});
  if(code.diagnostics?.some(d=>d.category===ts.DiagnosticCategory.Error))throw Error('frozen_transpile_failed');
  const module=await import('data:text/javascript;base64,'+Buffer.from(code.outputText).toString('base64'));
  return module.create(normalizeMemoryContractV2Event,async text=>crypto.createHash('sha256').update(text).digest('hex'))(input,candidates);
}
