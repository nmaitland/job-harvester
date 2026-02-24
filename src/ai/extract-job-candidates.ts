import { requestOpenRouterChat } from './openrouter-client';
import {
  type ExtractedJobCandidate,
  parseExtractedCandidates,
} from './validators';

interface ExtractCandidateContext {
  type: 'email' | 'webpage';
  hint?: string;
}

function buildExtractionPrompt(content: string, context: ExtractCandidateContext): string {
  const maxChars = context.type === 'email' ? 12000 : 20000;
  const trimmedContent = content.slice(0, maxChars);
  const sourceLabel = context.type === 'email' ? 'email' : 'web page';

  return [
    `Extract job links from this ${sourceLabel}.`,
    'Return JSON only, no markdown, with shape:',
    '{"candidates":[{"company":"...","title":"...","url":"https://..."}]}',
    'Rules:',
    '- Include only concrete job posting URLs, not unsubscribe or tracking links',
    '- Exclude generic company links without a specific role',
    '- If title is unclear, return "Unknown role"',
    '',
    context.hint ?? '',
    '',
    trimmedContent,
  ].join('\n');
}

export async function extractJobCandidates(
  content: string,
  context: ExtractCandidateContext
): Promise<ExtractedJobCandidate[]> {
  const response = await requestOpenRouterChat([
    {
      role: 'system',
      content: 'You extract structured job posting links from text content and return strict JSON only.',
    },
    {
      role: 'user',
      content: buildExtractionPrompt(content, context),
    },
  ]);

  return parseExtractedCandidates(response);
}

