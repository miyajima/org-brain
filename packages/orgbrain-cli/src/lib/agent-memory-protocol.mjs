import { createAmpRuntime } from '../../../shared/src/agent-memory-protocol.mjs';
import { countWikiTokens } from './wiki-service.mjs';
import { recallWiki } from './wiki-recall.mjs';

export { AMP_TOOLS, AMP_INPUT_SCHEMAS, ampJsonSchema, parseAmpPage, projectIndexPath } from '../../../shared/src/agent-memory-protocol.mjs';
export const { projectIndexContext, searchAmp, readAmp, validateAmpPage, saveAmp } =
  createAmpRuntime({ countTokens: countWikiTokens, recall: recallWiki });
