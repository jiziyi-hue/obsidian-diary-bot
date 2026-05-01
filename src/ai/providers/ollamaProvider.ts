import { AIProvider, ChatMessage } from './aiProvider';
import { requestUrl } from 'obsidian';

/**
 * Local Ollama provider. Hits http://localhost:11434/v1/chat/completions
 * (Ollama's OpenAI-compatible endpoint). No SDK required, ~30 LOC of fetch.
 *
 * Privacy mode: zero data leaves the user's machine. Falls back to cloud
 * provider if Ollama unreachable (caller's responsibility).
 *
 * Pattern borrowed from pfrankov/obsidian-local-gpt (MIT).
 */
export class OllamaProvider implements AIProvider {
  private baseUrl: string;
  private model: string;

  constructor(model: string = 'llama3.2', baseUrl: string = 'http://localhost:11434') {
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** Probe local Ollama. Returns true if reachable. */
  static async isAvailable(baseUrl: string = 'http://localhost:11434'): Promise<boolean> {
    try {
      const res = await requestUrl({
        url: `${baseUrl.replace(/\/+$/, '')}/api/tags`,
        method: 'GET',
        throw: false,
      });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  async chat(systemPrompt: string, messages: ChatMessage[]): Promise<string> {
    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];
    const res = await requestUrl({
      url: `${this.baseUrl}/v1/chat/completions`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: apiMessages,
        max_tokens: 1024,
        stream: false,
      }),
    });
    if (res.status !== 200) {
      throw new Error(`Ollama HTTP ${res.status}`);
    }
    const content = res.json?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Ollama: empty response');
    return content;
  }

  async summarize(systemPrompt: string, messages: ChatMessage[]): Promise<string> {
    const transcript = messages
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
    return this.chat(systemPrompt, [{ role: 'user', content: `Please summarize:\n\n${transcript}` }]);
  }
}
