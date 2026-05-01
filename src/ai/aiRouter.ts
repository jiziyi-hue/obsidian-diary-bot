import { AIProvider, ChatMessage } from './providers/aiProvider';
import { DeepSeekProvider } from './providers/deepseekProvider';
import { OpenAIProvider } from './providers/openaiProvider';
import { HostedProvider } from './providers/hostedProvider';
import { OllamaProvider } from './providers/ollamaProvider';
import type { DiaryBotSettings } from '../settings/settings';

/**
 * AI Router — selects the correct AI provider based on user settings.
 *
 * Self-hosted: user's own API key → direct provider
 * Hosted: uses hosted proxy → HostedProvider
 */
export class AIRouter implements AIProvider {
  private provider: AIProvider;

  constructor(settings: DiaryBotSettings) {
    this.provider = AIRouter.createProvider(settings);
  }

  static createProvider(settings: DiaryBotSettings): AIProvider {
    if (settings.serviceMode === 'hosted' && settings.creditToken) {
      return new HostedProvider(settings.creditToken);
    }

    const providerType = settings.aiProvider || 'deepseek';

    switch (providerType) {
      case 'ollama':
        return new OllamaProvider(
          settings.ollamaModel || 'llama3.2',
          settings.ollamaBaseUrl || 'http://localhost:11434'
        );
      case 'openai':
        return new OpenAIProvider(
          settings.openaiApiKey,
          settings.openaiModel || 'gpt-4o-mini',
          settings.openaiBaseUrl || 'https://api.openai.com/v1'
        );
      case 'deepseek':
      default:
        return new DeepSeekProvider(
          settings.deepseekApiKey,
          settings.deepseekModel || 'deepseek-chat'
        );
    }
  }

  /**
   * Rebuild provider when settings change.
   */
  rebuild(settings: DiaryBotSettings) {
    this.provider = AIRouter.createProvider(settings);
  }

  async chat(systemPrompt: string, messages: ChatMessage[]): Promise<string> {
    return this.provider.chat(systemPrompt, messages);
  }

  async summarize(systemPrompt: string, messages: ChatMessage[]): Promise<string> {
    return this.provider.summarize(systemPrompt, messages);
  }
}
