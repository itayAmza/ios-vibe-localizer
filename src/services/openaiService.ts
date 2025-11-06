import * as core from '@actions/core';
import OpenAI from 'openai';
import { TranslationRequest, BatchTranslationResponse } from '../types';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

let openai: OpenAI | undefined;

if (OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
  });
} else {
  core.warning('OpenAI API key is not set. Real translations will not be available.');
}

export class OpenAIService {
  private model: string;

  constructor(model: string) {
    if (!openai) {
      throw new Error('OpenAI client is not initialized. Please ensure OPENAI_API_KEY environment variable is set with a valid API key.');
    }
    this.model = model;
  }

  /**
   * Translates multiple strings to multiple target languages using OpenAI structured outputs in a single API call.
   * @param requests Array of translation requests containing key, text, and target languages.
   * @param sourceLanguage The language code of the original text (e.g., "en").
   * @param baseSystemPrompt Additional system prompt for context.
   * @returns A promise that resolves to the batch translation response.
   */
  async getBatchTranslations(requests: TranslationRequest[], sourceLanguage: string = "en", baseSystemPrompt: string = ""): Promise<BatchTranslationResponse> {
    if (!openai) {
      throw new Error('OpenAI client not initialized. Please ensure OPENAI_API_KEY environment variable is set with a valid API key.');
    }

    if (requests.length === 0) {
      return { translations: [] };
    }

    // Get all unique target languages from all requests
    const allTargetLanguages = [...new Set(requests.flatMap(req => req.targetLanguages))];
    
    core.info(`Requesting batch translation for ${requests.length} strings from ${sourceLanguage} to languages: ${allTargetLanguages.join(', ')} (temperature=0)`);

    // Create the schema for structured output
    const translationSchema = {
      type: "object",
      properties: {
        translations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: {
                type: "string",
                description: "The original key/identifier for the string"
              },
              translations: {
                type: "object",
                properties: Object.fromEntries(
                  allTargetLanguages.map(lang => [
                    lang,
                    {
                      type: "string",
                      description: `Translation in ${lang}`
                    }
                  ])
                ),
                required: allTargetLanguages,
                additionalProperties: false
              }
            },
            required: ["key", "translations"],
            additionalProperties: false
          }
        }
      },
      required: ["translations"],
      additionalProperties: false
    };

    const stringsToTranslate = requests.map(req => {
    let entry = `Key: "${req.key}"\nText: "${req.text}"`;
      if (req.comment) {
        entry += `\nContext: "${req.comment}"`;
      }
      return entry;
    }).join('\n\n');
    
    const systemPrompt = `You are a professional translator. Translate the following strings from ${sourceLanguage} to the specified target languages: ${allTargetLanguages.join(', ')}.

For each string, provide accurate, natural translations that preserve the meaning and context. If a string contains placeholders (like %@, %d, {0}, etc.), keep them exactly as they are in the translation.

When a Context is provided, use it to inform your translation choices for better accuracy and appropriateness.

Return the translations in the exact JSON structure specified.`;

    const userPrompt = `Translate these strings:\n\n${stringsToTranslate}`;

    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    
    if (baseSystemPrompt.trim()) {
      messages.push({ role: 'system', content: baseSystemPrompt.trim() });
    }
    
    messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userPrompt });

    try {
      const chatCompletion = await openai.chat.completions.create({
        model: this.model,
        messages: messages,
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "batch_translation",
            schema: translationSchema,
            strict: true
          }
        }
      });

      const responseContent = chatCompletion.choices[0]?.message?.content;
      if (!responseContent) {
        throw new Error('No content in OpenAI response');
      }

      const batchResponse: BatchTranslationResponse = JSON.parse(responseContent);
      // Diagnostics: usage and finish reason
      const finishReason = chatCompletion.choices?.[0]?.finish_reason ?? 'unknown';
      const usage = (chatCompletion as any).usage;
      if (usage) {
        core.info(`OpenAI usage: prompt=${usage.prompt_tokens}, completion=${usage.completion_tokens}, total=${usage.total_tokens}; finish_reason=${finishReason}`);
      } else {
        core.info(`OpenAI usage unavailable; finish_reason=${finishReason}`);
      }

      // Diagnostics: requested vs received and missing keys
      const requestedKeys = requests.map(r => r.key);
      const receivedKeys = new Set(batchResponse.translations.map(t => t.key));
      const missingKeys = requestedKeys.filter(k => !receivedKeys.has(k));
      core.info(`Requested: ${requestedKeys.length}, Received: ${receivedKeys.size}`);
      if (missingKeys.length > 0) {
        const preview = missingKeys.slice(0, 10);
        core.info(`Missing keys (first ${preview.length}): [${preview.join(', ')}]`);
      }

      core.info(`Received batch translations for ${batchResponse.translations.length} strings`);
      return batchResponse;

    } catch (error) {
      const errAny = error as any;
      const status = errAny?.status ?? errAny?.response?.status;
      const type = errAny?.error?.type ?? errAny?.response?.data?.error?.type;
      const message = errAny?.message ?? errAny?.error?.message ?? errAny?.response?.data?.error?.message;
      core.error(`Error in batch translation${status ? ` (${status})` : ''}${type ? ` ${type}` : ''}: ${message ?? String(error)}`);

      const headers = errAny?.headers ?? errAny?.response?.headers;
      if (headers) {
        const rateHeaders: string[] = [];
        for (const k of Object.keys(headers)) {
          if (k.toLowerCase().startsWith('x-ratelimit') || k.toLowerCase() === 'retry-after') {
            rateHeaders.push(`${k}=${headers[k]}`);
          }
        }
        if (rateHeaders.length > 0) {
          core.error(`Rate-limit headers: ${rateHeaders.join(', ')}`);
        } else {
          core.error('Rate-limit headers: unavailable');
        }
      } else {
        core.error('Response headers unavailable');
      }
      throw error;
    }
  }
} 