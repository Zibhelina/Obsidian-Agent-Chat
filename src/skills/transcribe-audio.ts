import { Skill } from "./types";

const TRANSCRIBE_AUDIO_PROMPT = `
## Transcribe Audio skill (active)

The user has activated /transcribe-audio. They want you to extract the exact spoken words from an audio file, producing a high-quality literal transcription. The user has provided an audio file or a reference to one in their vault.

Your job is to leverage your multimodal audio input capabilities. You will receive the audio directly as part of the user's message.

Follow these rules:
1. Do not refuse, saying you cannot listen to audio. If the audio is provided via the platform mechanism, use your native audio processing capabilities to transcribe it.
2. Provide a 1:1 word-for-word transcript. Do not summarize or paraphrase unless explicitly asked.
3. If the audio is unclear, indicate the timestamp and use [inaudible] or [unclear].
4. Output the transcription clearly formatted with paragraphs or timestamps as appropriate.
5. If you do not have native audio capabilities or the audio file format is unsupported by your endpoint, explain the limitation clearly and concisely without fabricating a transcription.
`;

export const transcribeAudioSkill: Skill = {
  id: "transcribe-audio",
  label: "Transcribe audio",
  description: "Word-for-word audio transcription via native model audio inputs",
  systemPrompt: TRANSCRIBE_AUDIO_PROMPT,
  icon: "mic",
  placeholder: "Attach audio for transcription...",
  kind: "custom"
};
