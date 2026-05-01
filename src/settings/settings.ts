export type ReplyMode = 'silent' | 'conversation';

export interface DiaryBotSettings {
  // --- Service Mode ---
  serviceMode: 'self-hosted' | 'hosted';

  // --- AI Provider ---
  aiProvider: 'deepseek' | 'openai' | 'ollama';
  deepseekApiKey: string;
  deepseekModel: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiBaseUrl: string;
  ollamaBaseUrl: string;
  ollamaModel: string;

  // --- Relay ---
  relayUrl: string;
  telegramBotToken: string; // self-hosted only: for photo download
  creditToken: string;
  relayUserId: string;
  credits: number;

  // --- Shared ---
  allowedUserId: string;
  maxFollowUpQuestions: number;
  sessionTimeoutMinutes: number;

  // --- Interaction mode + persona ---
  replyMode: ReplyMode;

  // --- Memory ---
  enableMemory: boolean;        // recency layer
  memoryDays: number;           // recency window
  enableTagRag: boolean;        // tag-overlap layer
  enableEntityLinks: boolean;   // entity-linked layer + auto-create entity notes
  enableVaultWideSearch: boolean; // search entire vault (not just diary folder)
  memoryTokenBudget: number;    // max tokens for memory block per AI call

  // --- Vault layout ---
  diaryFolder: string;
  peopleFolder: string;
  placesFolder: string;
  projectsFolder: string;
  dailyNoteFormat: string;
  appendMode: boolean;

  // --- Reports ---
  enableDailyReport: boolean;
  dailyReportTime: string;
}

export const DEFAULT_SETTINGS: DiaryBotSettings = {
  serviceMode: 'self-hosted',

  aiProvider: 'deepseek',
  deepseekApiKey: '',
  deepseekModel: 'deepseek-chat',
  openaiApiKey: '',
  openaiModel: 'gpt-4o-mini',
  openaiBaseUrl: 'https://api.openai.com/v1',
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.2',

  relayUrl: '',
  telegramBotToken: '',
  creditToken: '',
  relayUserId: '',
  credits: 0,

  allowedUserId: '',
  maxFollowUpQuestions: 3,
  sessionTimeoutMinutes: 30,

  replyMode: 'conversation',

  enableMemory: true,
  memoryDays: 7,
  enableTagRag: true,
  enableEntityLinks: true,
  enableVaultWideSearch: false,
  memoryTokenBudget: 8000,

  diaryFolder: 'Journal',
  peopleFolder: 'Journal/People',
  placesFolder: 'Journal/Places',
  projectsFolder: 'Journal/Projects',
  dailyNoteFormat: 'YYYY-MM-DD',
  appendMode: true,

  enableDailyReport: true,
  dailyReportTime: '21:00',
};
