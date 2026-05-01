// Unified AI Provider interface

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AIProvider {
  chat(systemPrompt: string, messages: ChatMessage[]): Promise<string>;
  summarize(systemPrompt: string, messages: ChatMessage[]): Promise<string>;
}
