import { create } from "zustand";
import { DEFAULT_MEMORY_MODEL_ID, DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID, getProvider } from "@/constants/providers";
import type { AIProvider, Approach, Language, SessionMode, TherapySchool, ThinkingLevel, ThinkingType, TTSModel, TTSVoice } from "@/types";

interface SettingsState {
  language: Language;
  provider: AIProvider;
  apiKey: string;
  model: string;
  customBaseUrl: string;
  /** Context window for user-entered models (local/OpenAI-compatible), which aren't in the static model table. */
  customContextWindow: number;
  /** Minutes to keep a local model resident. 0 = server default, -1 = until Ollama exits. */
  localKeepAliveMinutes: number;
  approach: Approach;
  preferredSessionTime: string;
  sessionDurationMinutes: number;
  therapySchool: TherapySchool;
  thinkingEnabled: boolean;
  thinkingLevel: ThinkingLevel;
  thinkingType: ThinkingType;
  providerApiKeys: Record<string, string>;
  providerThinkingSettings: Record<string, { enabled: boolean; level: ThinkingLevel; type?: ThinkingType }>;
  memoryModel: string;
  memoryThinkingEnabled: boolean;
  memoryThinkingLevel: ThinkingLevel;
  memoryThinkingType: ThinkingType;
  providerMemoryThinkingSettings: Record<string, { enabled: boolean; level: ThinkingLevel; type?: ThinkingType }>;
  transcriptApiKey: string;
  ttsModel: TTSModel;
  ttsVoice: TTSVoice;
  preferredSessionMode: SessionMode;
  setLanguage: (language: Language) => void;
  setProvider: (provider: AIProvider) => void;
  setApiKey: (key: string) => void;
  setModel: (model: string) => void;
  setCustomBaseUrl: (url: string) => void;
  setCustomContextWindow: (tokens: number) => void;
  setLocalKeepAliveMinutes: (minutes: number) => void;
  setApproach: (approach: Approach) => void;
  setPreferredSessionTime: (time: string) => void;
  setSessionDurationMinutes: (minutes: number) => void;
  setThinkingEnabled: (enabled: boolean) => void;
  setTherapySchool: (school: TherapySchool) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
  setThinkingType: (type: ThinkingType) => void;
  setMemoryModel: (model: string) => void;
  setMemoryThinkingEnabled: (enabled: boolean) => void;
  setMemoryThinkingLevel: (level: ThinkingLevel) => void;
  setMemoryThinkingType: (type: ThinkingType) => void;
  setTranscriptApiKey: (key: string) => void;
  setTtsModel: (model: TTSModel) => void;
  setTtsVoice: (voice: TTSVoice) => void;
  setPreferredSessionMode: (mode: SessionMode) => void;
  loadFromStore: (data: Partial<SettingsState>) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  language: "tr",
  provider: DEFAULT_PROVIDER_ID,
  apiKey: "",
  model: DEFAULT_MODEL_ID,
  customBaseUrl: "",
  customContextWindow: 8192,
  localKeepAliveMinutes: 30,
  approach: "balanced",
  preferredSessionTime: "20:00",
  sessionDurationMinutes: 50,
  therapySchool: "integrative",
  thinkingEnabled: true,
  thinkingLevel: "medium",
  thinkingType: "budget",
  providerApiKeys: {},
  providerThinkingSettings: {},
  memoryModel: DEFAULT_MEMORY_MODEL_ID,
  memoryThinkingEnabled: true,
  memoryThinkingLevel: "medium",
  memoryThinkingType: "budget",
  providerMemoryThinkingSettings: {},
  transcriptApiKey: "",
  ttsModel: "tts-1",
  ttsVoice: "alloy",
  preferredSessionMode: "chat",
  setLanguage: (language) => set({ language }),
  setProvider: (provider) => {
    const state = get();
    const updatedKeys = { ...state.providerApiKeys, [state.provider]: state.apiKey };
    const newApiKey = updatedKeys[provider] ?? "";

    // Save current provider's chat thinking settings
    const updatedThinking = {
      ...state.providerThinkingSettings,
      [state.provider]: { enabled: state.thinkingEnabled, level: state.thinkingLevel, type: state.thinkingType },
    };

    // Save current provider's memory thinking settings
    const updatedMemoryThinking = {
      ...state.providerMemoryThinkingSettings,
      [state.provider]: { enabled: state.memoryThinkingEnabled, level: state.memoryThinkingLevel, type: state.memoryThinkingType },
    };

    // Restore new provider's chat thinking settings (or defaults)
    const restored = updatedThinking[provider] ?? { enabled: false, level: "medium" as ThinkingLevel, type: "budget" as ThinkingType };
    const restoredLevel = restored.level;
    const restoredType = provider === "openai" ? "budget" as ThinkingType : (restored.type ?? "budget" as ThinkingType);

    // Restore new provider's memory thinking settings (or defaults)
    const restoredMemory = updatedMemoryThinking[provider] ?? { enabled: false, level: "medium" as ThinkingLevel, type: "budget" as ThinkingType };
    const restoredMemoryLevel = restoredMemory.level;
    const restoredMemoryType = provider === "openai" ? "budget" as ThinkingType : (restoredMemory.type ?? "budget" as ThinkingType);

    // Reset models to new provider's first model.
    // Providers with an empty model list (local / OpenAI-compatible) take free text instead,
    // so blank them rather than carrying the previous provider's model name across.
    const newProvider = getProvider(provider);
    const usesCustomModels = newProvider !== undefined && newProvider.models.length === 0;
    const newModel = usesCustomModels ? "" : newProvider?.models[0]?.id ?? state.model;
    const newMemoryModel = usesCustomModels
      ? ""
      : provider === DEFAULT_PROVIDER_ID
        ? DEFAULT_MEMORY_MODEL_ID
        : newProvider?.models[0]?.id ?? state.memoryModel;

    set({
      provider,
      apiKey: newApiKey,
      model: newModel,
      memoryModel: newMemoryModel,
      providerApiKeys: updatedKeys,
      thinkingEnabled: restored.enabled,
      thinkingLevel: restoredLevel,
      thinkingType: restoredType,
      providerThinkingSettings: updatedThinking,
      memoryThinkingEnabled: restoredMemory.enabled,
      memoryThinkingLevel: restoredMemoryLevel,
      memoryThinkingType: restoredMemoryType,
      providerMemoryThinkingSettings: updatedMemoryThinking,
    });
  },
  setApiKey: (apiKey) => {
    const state = get();
    set({
      apiKey,
      providerApiKeys: { ...state.providerApiKeys, [state.provider]: apiKey },
    });
  },
  setModel: (model) => set({ model }),
  setCustomBaseUrl: (customBaseUrl) => set({ customBaseUrl }),
  setCustomContextWindow: (customContextWindow) => set({ customContextWindow }),
  setLocalKeepAliveMinutes: (localKeepAliveMinutes) => set({ localKeepAliveMinutes }),
  setApproach: (approach) => set({ approach }),
  setPreferredSessionTime: (preferredSessionTime) => set({ preferredSessionTime }),
  setSessionDurationMinutes: (sessionDurationMinutes) => set({ sessionDurationMinutes }),
  setThinkingEnabled: (thinkingEnabled) => set({ thinkingEnabled }),
  setTherapySchool: (therapySchool) => set({ therapySchool }),
  setThinkingLevel: (thinkingLevel) => set({ thinkingLevel }),
  setThinkingType: (thinkingType) => set({ thinkingType }),
  setMemoryModel: (memoryModel) => set({ memoryModel }),
  setMemoryThinkingEnabled: (memoryThinkingEnabled) => set({ memoryThinkingEnabled }),
  setMemoryThinkingLevel: (memoryThinkingLevel) => set({ memoryThinkingLevel }),
  setMemoryThinkingType: (memoryThinkingType) => set({ memoryThinkingType }),
  setTranscriptApiKey: (transcriptApiKey) => set({ transcriptApiKey }),
  setTtsModel: (ttsModel) => set({ ttsModel }),
  setTtsVoice: (ttsVoice) => set({ ttsVoice }),
  setPreferredSessionMode: (preferredSessionMode) => set({ preferredSessionMode }),
  loadFromStore: (data) => set(data),
}));
