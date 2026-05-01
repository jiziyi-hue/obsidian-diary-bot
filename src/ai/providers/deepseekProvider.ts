import { AIProvider, ChatMessage } from './aiProvider';
import { requestWithRetry } from './requestWithRetry';

/**
 * Direct connection to DeepSeek API using user's own API key.
 * Used in FREE mode.
 */
export class DeepSeekProvider implements AIProvider {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = 'deepseek-chat') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async chat(systemPrompt: string, messages: ChatMessage[]): Promise<string> {
    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages
    ];

    const response = await requestWithRetry({
      url: 'https://api.deepseek.com/chat/completions',
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
