import { OpenAIProvider } from '@openai/agents-openai';
import { DEFAULT_GEMINI_MODEL } from './model';

export { DEFAULT_GEMINI_MODEL } from './model';

/** Gemini OpenAI-compatible Chat Completions endpoint. */
export const GEMINI_OPENAI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/';

/**
 * Prefer GEMINI_API_KEY (Gemini OpenAI-compat docs); accept GOOGLE_API_KEY
 * (Google AI Studio / genai Client convention) as an alias.
 */
export function resolveGeminiApiKey(): string | undefined {
  return (
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    undefined
  );
}

export function requireGeminiApiKey(): string {
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    throw new Error(
      'Missing Gemini API key. Set GEMINI_API_KEY (or GOOGLE_API_KEY) in .env. ' +
        'Do not commit secrets.',
    );
  }
  return apiKey;
}

export function geminiModelName(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

/**
 * OpenAI Agents SDK provider pointed at Gemini.
 * useResponses: false — Gemini’s OpenAI bridge speaks Chat Completions.
 */
export function createGeminiModelProvider(apiKey: string): OpenAIProvider {
  return new OpenAIProvider({
    apiKey,
    baseURL: GEMINI_OPENAI_BASE_URL,
    useResponses: false,
  });
}
