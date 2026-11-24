import { createAnthropic } from '../../../anthropic/src/index.js';
import { createAzure } from '../../../azure/src/index.js';
import { createCohere } from '../../../cohere/src/index.js';
import { createElevenLabs } from '../../../elevenlabs/src/index.js';
import { createFal } from '../../../fal/src/index.js';
import { createGoogle } from '../../../google/src/index.js';
import { createGroq } from '../../../groq/src/index.js';
import { createLuma } from '../../../luma/src/index.js';
import { createMiniMax } from '../../../minimax/src/index.js';
import { createOpenAI } from '../../../openai/src/index.js';
import { createReplicate } from '../../../replicate/src/index.js';
import { createTogetherAI } from '../../../togetherai/src/index.js';
import { createTypeSafeAi } from '../../../typesafe-ai/src/index.js';
import { createVoyage } from '../../../voyage/src/index.js';

type NamedModel = {
  name: string;
  model: { readonly provider: string; readonly modelId: string };
};

/**
 * Creates provider models inside the workflow, then passes them into a step.
 * The step only reads provider and model id. It does not call a provider API.
 */
export async function persistProviderModelsWorkflow(): Promise<
  Array<{ name: string; provider: string; modelId: string }>
> {
  'use workflow';
  return readModelIdentity(createProviderModels());
}

function createProviderModels(): NamedModel[] {
  return [
    { name: 'openai', model: createOpenAI().chat('gpt-4o-mini') },
    {
      name: 'anthropic',
      model: createAnthropic().languageModel('claude-3-haiku-20240307'),
    },
    { name: 'cohere', model: createCohere()('command-r-plus') },
    { name: 'voyage', model: createVoyage().embedding('voyage-4') },
    { name: 'fal', model: createFal().image('fal-ai/aura-sr') },
    { name: 'luma', model: createLuma().image('photon-1') },
    {
      name: 'replicate',
      model: createReplicate().image('black-forest-labs/flux-schnell'),
    },
    {
      name: 'together',
      model: createTogetherAI()('meta-llama/Llama-3.3-70B-Instruct-Turbo'),
    },
    {
      name: 'typesafe',
      model: createTypeSafeAi().evaluationModel('jev-latest'),
    },
    {
      name: 'azure',
      model: createAzure({ resourceName: 'placeholder-resource' }).chat(
        'gpt-4o-mini',
      ),
    },
    {
      name: 'elevenlabs',
      model: createElevenLabs().speech('eleven_multilingual_v2'),
    },
    { name: 'google', model: createGoogle().languageModel('gemini-2.0-flash') },
    { name: 'groq', model: createGroq().chat('llama-3.1-8b-instant') },
    { name: 'minimax-chat', model: createMiniMax().chat('minimax-m2') },
  ];
}

async function readModelIdentity(
  models: NamedModel[],
): Promise<Array<{ name: string; provider: string; modelId: string }>> {
  'use step';
  return models.map(entry => ({
    name: entry.name,
    provider: entry.model.provider,
    modelId: entry.model.modelId,
  }));
}
