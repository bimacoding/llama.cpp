/**
 * useVoiceConversation
 *
 * Reactive hook that drives the Voice Conversation feature. It glues:
 *   1. AudioRecorder (browser MediaRecorder) for capturing user speech
 *   2. OpenRouterAudioService for STT (transcribe) and TTS (synthesize)
 *   3. chatStore.sendMessage() so the existing chat pipeline (tools, MCP,
 *      agentic flow, streaming) is fully reused
 *
 * The hook exposes a state-machine-like `phase` plus simple controls
 * (`start`, `stopRecording`, `end`). UI components subscribe to `phase`
 * and `transcript` to render an animated overlay; once the conversation
 * ends the persisted chat history remains in the normal chat view.
 */

import { untrack } from 'svelte';
import { chatStore } from '$lib/stores/chat.svelte';
import { conversationsStore } from '$lib/stores/conversations.svelte';
import { config } from '$lib/stores/settings.svelte';
import { AudioRecorder, convertToWav, isAudioRecordingSupported } from '$lib/utils/browser-only';
import {
	OpenRouterAudioError,
	OpenRouterAudioService,
	type OpenRouterAudioConfig
} from '$lib/services/openrouter-audio.service';
import { MessageRole } from '$lib/enums';

export type VoicePhase =
	| 'idle'
	| 'listening'
	| 'processing_stt'
	| 'sending_llm'
	| 'processing_tts'
	| 'speaking'
	| 'awaiting_playback';

export interface VoiceTranscriptEntry {
	id: string;
	role: 'user' | 'assistant';
	text: string;
	timestamp: number;
}

function readVoiceConfig(): OpenRouterAudioConfig {
	const c = config();
	return {
		apiKey: String(c.voiceApiKey ?? ''),
		sttModel: String(c.voiceSttModel ?? 'openai/whisper-1'),
		ttsModel: String(c.voiceTtsModel ?? 'openai/gpt-4o-mini-tts-2025-12-15'),
		ttsVoice: String(c.voiceTtsVoice ?? 'alloy')
	};
}

export function useVoiceConversation() {
	let phase = $state<VoicePhase>('idle');
	let errorMessage = $state<string | null>(null);
	let transcript = $state<VoiceTranscriptEntry[]>([]);

	let recorder: AudioRecorder | null = null;
	const recordingSupported = isAudioRecordingSupported();

	// Tracks the last assistant message id we already spoke, so that when the
	// existing chat pipeline finishes a generation we don't replay stale ones.
	let lastSpokenAssistantId: string | null = null;
	let activeAudio: HTMLAudioElement | null = null;
	let pendingPlaybackBlob: Blob | null = null;
	let ttsAbort: AbortController | null = null;
	let isActive = false;

	function setError(message: string): void {
		errorMessage = message;
		console.error('[voice-conversation]', message);
	}

	function clearError(): void {
		errorMessage = null;
	}

	function isPlaybackBlockedError(error: unknown): boolean {
		if (!(error instanceof Error)) return false;
		return /blocked by browser policy|notallowederror|user denied permission|not allowed/i.test(
			error.message
		);
	}

	function appendTranscript(role: 'user' | 'assistant', text: string): void {
		transcript = [
			...transcript,
			{
				id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				role,
				text,
				timestamp: Date.now()
			}
		];
	}

	function stopActiveAudio(): void {
		if (activeAudio) {
			try {
				activeAudio.pause();
				activeAudio.src = '';
			} catch {
				// noop
			}
			activeAudio = null;
		}
		if (ttsAbort) {
			ttsAbort.abort();
			ttsAbort = null;
		}
	}

	async function start(): Promise<void> {
		if (!recordingSupported) {
			setError('Audio recording is not supported in this browser.');
			return;
		}
		clearError();
		isActive = true;

		// Anchor on the conversation's latest assistant message so we ignore
		// historical assistant messages already present before the session.
		lastSpokenAssistantId = findLatestAssistantMessageId();

		await beginRecording();
	}

	async function beginRecording(): Promise<void> {
		if (!isActive) return;
		try {
			if (!recorder) recorder = new AudioRecorder();
			await recorder.startRecording();
			phase = 'listening';
		} catch (error) {
			setError(error instanceof Error ? error.message : 'Failed to start microphone.');
			phase = 'idle';
		}
	}

	async function stopRecording(): Promise<void> {
		if (phase !== 'listening' || !recorder) return;
		phase = 'processing_stt';

		let audioBlob: Blob;
		try {
			audioBlob = await recorder.stopRecording();
		} catch (error) {
			setError(error instanceof Error ? error.message : 'Failed to stop recording.');
			phase = 'idle';
			return;
		}

		// Whisper-style models accept wav/m4a/mp3 well; normalize to WAV when feasible.
		try {
			audioBlob = await convertToWav(audioBlob);
		} catch {
			// fall back to raw blob
		}

		await transcribeAndSend(audioBlob);
	}

	async function transcribeAndSend(audioBlob: Blob): Promise<void> {
		const voiceConfig = readVoiceConfig();
		let transcribed: string;
		try {
			transcribed = await OpenRouterAudioService.transcribeAudio(audioBlob, voiceConfig);
		} catch (error) {
			handleAudioError(error, 'speech recognition');
			phase = 'idle';
			return;
		}

		appendTranscript('user', transcribed);
		phase = 'sending_llm';

		try {
			await chatStore.sendMessage(transcribed);
		} catch (error) {
			setError(error instanceof Error ? error.message : 'Failed to send message.');
			phase = 'idle';
			return;
		}
		// After sendMessage resolves, the assistant response is already complete
		// (sendMessage awaits the streaming/agentic loop). Pick it up and speak it.
		await speakLatestAssistantMessage();
	}

	async function speakLatestAssistantMessage(): Promise<void> {
		if (!isActive) return;

		const latestId = findLatestAssistantMessageId();
		if (!latestId || latestId === lastSpokenAssistantId) {
			// No new assistant message — go back to listening so the user can speak again.
			if (isActive) await beginRecording();
			return;
		}
		lastSpokenAssistantId = latestId;

		const text = readAssistantMessageText(latestId);
		if (!text) {
			if (isActive) await beginRecording();
			return;
		}

		appendTranscript('assistant', text);

		phase = 'processing_tts';
		const voiceConfig = readVoiceConfig();
		ttsAbort = new AbortController();
		let audioBlob: Blob;
		try {
			audioBlob = await OpenRouterAudioService.synthesizeSpeech(text, voiceConfig, ttsAbort.signal);
		} catch (error) {
			ttsAbort = null;
			handleAudioError(error, 'text-to-speech');
			if (isActive) await beginRecording();
			return;
		}
		ttsAbort = null;

		try {
			await playAudioBlob(audioBlob);
			if (isActive) {
				await beginRecording();
			}
		} catch (error) {
			if (isPlaybackBlockedError(error)) {
				pendingPlaybackBlob = audioBlob;
				phase = 'awaiting_playback';
				setError(
					'Audio diblok browser. Tekan tombol "Play response" untuk memutar jawaban suara.'
				);
				return;
			}
			setError(error instanceof Error ? error.message : 'Failed to play synthesized audio.');
			if (isActive) {
				await beginRecording();
			}
		}
	}

	async function playAudioBlob(blob: Blob): Promise<void> {
		stopActiveAudio();

		phase = 'speaking';

		const url = URL.createObjectURL(blob);
		const audio = new Audio(url);
		activeAudio = audio;

		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				URL.revokeObjectURL(url);
				if (activeAudio === audio) activeAudio = null;
			};
			audio.onerror = () => {
				cleanup();
				reject(new Error('Audio playback failed.'));
			};
			audio.play().catch((error) => {
				cleanup();
				reject(
					new Error(
						`Audio playback blocked by browser policy: ${error instanceof Error ? error.message : String(error)}`
					)
				);
			});
			audio.onended = () => {
				cleanup();
				resolve();
			};
		});
	}

	function findLatestAssistantMessageId(): string | null {
		const messages = untrack(() => conversationsStore.activeMessages);
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role === MessageRole.ASSISTANT) return m.id;
		}
		return null;
	}

	function readAssistantMessageText(messageId: string): string {
		const messages = untrack(() => conversationsStore.activeMessages);
		const target = messages.find((m) => m.id === messageId);
		if (!target) return '';
		const raw = (target.content || '').trim();
		// Strip simple markdown / agentic fences so TTS reads natural prose.
		return sanitizeForTts(raw);
	}

	function sanitizeForTts(text: string): string {
		return text
			.replace(/```[\s\S]*?```/g, ' ')
			.replace(/`([^`]+)`/g, '$1')
			.replace(/\*\*([^*]+)\*\*/g, '$1')
			.replace(/\*([^*]+)\*/g, '$1')
			.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
			.replace(/\s+/g, ' ')
			.trim();
	}

	function handleAudioError(error: unknown, context: string): void {
		if (error instanceof OpenRouterAudioError) {
			setError(`${context}: ${error.message}`);
		} else if (error instanceof Error) {
			setError(`${context}: ${error.message}`);
		} else {
			setError(`${context} failed.`);
		}
	}

	async function playPendingAudio(): Promise<void> {
		if (!pendingPlaybackBlob) return;
		const blob = pendingPlaybackBlob;
		pendingPlaybackBlob = null;
		clearError();

		try {
			await playAudioBlob(blob);
		} catch (error) {
			// Keep pending payload so the user can retry play again.
			pendingPlaybackBlob = blob;
			setError(error instanceof Error ? error.message : 'Failed to play synthesized audio.');
			phase = 'awaiting_playback';
			return;
		}

		if (isActive) {
			await beginRecording();
		} else {
			phase = 'idle';
		}
	}

	/**
	 * Called from explicit user gestures (button clicks/taps).
	 * If autoplay was previously blocked and a response is pending,
	 * retry playback immediately so the user doesn't have to click
	 * a dedicated "Play" button every time.
	 */
	async function onUserGesture(): Promise<void> {
		if (!pendingPlaybackBlob) return;
		await playPendingAudio();
	}

	function end(): void {
		isActive = false;
		stopActiveAudio();
		pendingPlaybackBlob = null;
		if (recorder && recorder.isRecording()) {
			try {
				recorder.cancelRecording();
			} catch {
				// noop
			}
		}
		recorder = null;
		phase = 'idle';
	}

	return {
		get phase() {
			return phase;
		},
		get errorMessage() {
			return errorMessage;
		},
		get transcript() {
			return transcript;
		},
		get isSupported() {
			return recordingSupported;
		},
		get hasPendingPlayback() {
			return pendingPlaybackBlob !== null;
		},
		start,
		stopRecording,
		playPendingAudio,
		onUserGesture,
		end
	};
}
