import { AIProvider, ChatMessage } from './aiProvider';
import { requestWithRetry } from './requestWithRetry';

/**
 * OpenAI-compatible provider. Works with OpenAI, Claude (via proxy), etc.
 * Used in FREE mode when user provides their own key.
 */
export class OpenAIProvider implements AIProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(apiKey: string, model: string = 'gpt-4o-mini', baseUrl: string = 'https://api.openai.com/v1') {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async chat(systemPrompt: string, messages: ChatMessage[]): Promise<string> {
    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages
    ];

    const response = await requestWithRetry({
      url: `${this.baseUrl}/chat/completions`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: apiMessages,
        max_tokens: 1024,
      })
    });

    return response.json.choices[0].message.content;
  }

  async summarize(systemPrompt: string, messages: ChatMessage[]): Promise<string> {
    const transcript = messages
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
    return this.chat(systemPrompt, [{ role: 'user', content: `Please summarize:\n\n${transcript}` }]);
  }
}
