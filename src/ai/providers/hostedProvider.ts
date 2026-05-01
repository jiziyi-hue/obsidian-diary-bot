import { AIProvider, ChatMessage } from './aiProvider';
import { requestWithRetry } from './requestWithRetry';

/**
 * Hosted AI proxy — calls YOUR paid relay API.
 * Used in PAID mode. Deducts credits per request.
 * The relay server forwards to DeepSeek/Gemini using your master key.
 */

// Paid/hosted provider is not active in v1.0 (Free-only release).
// Set this to your hosted relay URL when enabling the paid mode.
const HOSTED_API_URL = '';

export class HostedProvider implements AIProvider {
  private creditToken: string;

  constructor(creditToken: string) {
    this.creditToken = creditToken;
  }

  async chat(systemPrompt: string, messages: ChatMessage[]): Promise<string> {
    if (!HOSTED_API_URL) throw new Error('Hosted mode is not configured.');
    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages
    ];

    let response;
    try {
      response = await requestWithRetry({
        url: HOSTED_API_URL,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.creditToken}`
        },
        body: JSON.stringify({
          messages: apiMessages,
          max_tokens: 1024,
        })
      });
    } catch (e: any) {
      if (typeof e?.message === 'string' && e.message.startsWith('HTTP 402')) {
        throw new Error('Insufficient credits. Please top up in plugin settings.');
      }
      throw e;
    }

    const data = response.json;
    return data.choices?.[0]?.message?.content || data.content || '';
  }

  async summarize(systemPrompt: string, messages: ChatMessage[]): Promise<string> {
    const transcript = messages
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
    return this.chat(systemPrompt, [{ role: 'user', content: `Please summarize:\n\n${transcript}` }]);
  }
}
