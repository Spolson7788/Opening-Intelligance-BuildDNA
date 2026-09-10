import { readFileSync, writeFileSync } from 'node:fs';
import { buildUnattendedPrompt } from './unattendedPrompt.js';

const [checkpointPath, outputPath, laneId, manufacturerGroup, executionOwner, allowedWriteRoot, branch] = process.argv.slice(2);
if (!checkpointPath || !outputPath || !laneId || !manufacturerGroup || !executionOwner || !allowedWriteRoot || !branch) {
  throw new Error('Usage: prepareUnattendedPromptCli <checkpoint> <output> <lane> <manufacturer> <owner> <allowedRoot> <branch>');
}

const checkpointText = readFileSync(checkpointPath, 'utf8');
const prompt = buildUnattendedPrompt({
  checkpointPath,
  checkpointText,
  laneId,
  manufacturerGroup,
  executionOwner,
  allowedWriteRoot,
  branch
});

writeFileSync(outputPath, prompt, 'utf8');
console.log(`UNATTENDED_PROMPT_READY:${laneId}:${outputPath}`);
