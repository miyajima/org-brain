import { createAmpRuntime } from '@org-brain/shared/runtime/agent-memory-protocol';
import { countWikiTokens } from './wiki-service.mjs';
import { recallWiki } from './wiki-recall.mjs';

export { AMP_TOOLS, AMP_INPUT_SCHEMAS, ampJsonSchema, parseAmpPage, projectIndexPath } from '@org-brain/shared/runtime/agent-memory-protocol';
export const { projectIndexContext, searchAmp, readAmp, validateAmpPage, saveAmp } =
  createAmpRuntime({ countTokens: countWikiTokens, recall: recallWiki });
