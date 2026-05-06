/**
 * OpenRouterAudioService
 *
 * Stateless service that wraps OpenRouter's OpenAI-compatible audio endpoints
 * for speech-to-text (transcriptions) and text-to-speech (speech).
 *
 * The voice conversation feature uses these to bridge spoken user input into
 * the existing chat pipeline (so tools, MCP servers, agentic flow, and streaming
 * remain untouched) and to read assistant responses back to the user.
 */

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_TTS_ENDPOINTS = ['/audio/speech', '/tts'] as const;
const OPENROUTER_TTS_FALLBACK_MODELS = [
	'openai/gpt-4o-mini-tts-2025-12-15',
	'mistralai/voxtral-mini-tts-2603',
	'google/gemini-3.1-flash-tts-preview'
];

export interface OpenRouterAudioConfig {
	apiKey: string;
	sttModel: string;
	ttsModel: string;
	ttsVoice: string;
}

export class OpenRouterAudioError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
		public readonly cause?: unknown
	) {
		super(message);
		this.name = 'OpenRouterAudioError';
	}
}

function ensureApiKey(apiKey: string): void {
	if (!apiKey || !apiKey.trim()) {
		throw new OpenRouterAudioError(
			'OpenRouter API key is not configured. Set it in Settings → Voice Conversation.'
		);
	}
}

/**
 * Map a recorded audio Blob's MIME type to one of the formats accepted by
 * OpenRouter's STT endpoint (wav, mp3, flac, m4a, ogg, webm, aac).
 */
function inferAudioFormat(blob: Blob): string {
	const type = (blob.type || '').toLowerCase();
	if (type.includes('wav')) return 'wav';
	if (type.includes('webm')) return 'webm';
	if (type.includes('m4a') || type.includes('mp4') || type.includes('aac')) return 'm4a';
	if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
	if (type.includes('ogg') || type.includes('opus')) return 'ogg';
	if (type.includes('flac')) return 'flac';
	// Default to wav since callers normalize to WAV before calling.
	return 'wav';
}

/**
 * Convert a Blob to a raw base64 string (without a data URI prefix), suitable
 * for OpenRouter's `input_audio.data` field.
 */
async function blobToBase64(blob: Blob): Promise<string> {
	const buffer = await blob.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	// Build a binary string in chunks to avoid argument-length issues
	// for large recordings (`String.fromCharCode(...bytes)` would blow the stack).
	const CHUNK = 0x8000;
	let binary = '';
	for (let i = 0; i < bytes.length; i += CHUNK) {
		const slice = bytes.subarray(i, i + CHUNK);
		binary += String.fromCharCode.apply(null, Array.from(slice));
	}
	return btoa(binary);
}

export class OpenRouterAudioService {
	private static async requestTts(
		text: string,
		config: OpenRouterAudioConfig,
		model: string,
		endpoint: (typeof OPENROUTER_TTS_ENDPOINTS)[number],
		signal?: AbortSignal
	): Promise<Response> {
		return fetch(`${OPENROUTER_BASE_URL}${endpoint}`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				model,
				voice: config.ttsVoice,
				input: text,
				response_format: 'mp3'
			}),
			signal
		});
	}

	/**
	 * Transcribe an audio blob using OpenRouter's `/audio/transcriptions`
	 * endpoint. Note: OpenRouter does NOT use OpenAI's multipart form-data
	 * shape here — it expects a JSON body with base64-encoded audio under
	 * `input_audio.data` and `input_audio.format`.
	 *
	 * @param blob   Recorded audio blob (any browser-recorded format works).
	 * @param config Voice conversation configuration with API key + model.
	 * @param signal Optional abort signal for cancellation.
	 * @returns      Transcribed text (server response `text` field).
	 */
	static async transcribeAudio(
		blob: Blob,
		config: OpenRouterAudioConfig,
		signal?: AbortSignal
	): Promise<string> {
		ensureApiKey(config.apiKey);

		const format = inferAudioFormat(blob);
		const data = await blobToBase64(blob);

		let response: Response;
		try {
			response = await fetch(`${OPENROUTER_BASE_URL}/audio/transcriptions`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${config.apiKey}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					model: config.sttModel,
					input_audio: {
						data,
						format
					}
				}),
				signal
			});
		} catch (error) {
			throw new OpenRouterAudioError('Failed to reach OpenRouter STT endpoint.', undefined, error);
		}

		if (!response.ok) {
			const errorText = await response.text().catch(() => '');
			throw new OpenRouterAudioError(
				`OpenRouter STT request failed (${response.status}): ${errorText || response.statusText}`,
				response.status
			);
		}

		const payload = (await response.json()) as { text?: string };
		const text = (payload.text || '').trim();
		if (!text) {
			throw new OpenRouterAudioError('OpenRouter STT returned an empty transcript.');
		}
		return text;
	}

	/**
	 * Synthesize speech from text using OpenRouter's `/audio/speech` endpoint.
	 * Returns a Blob (typically audio/mpeg) ready to feed into an HTMLAudioElement.
	 */
	static async synthesizeSpeech(
		text: string,
		config: OpenRouterAudioConfig,
		signal?: AbortSignal
	): Promise<Blob> {
		ensureApiKey(config.apiKey);

		const trimmed = text.trim();
		if (!trimmed) {
			throw new OpenRouterAudioError('Cannot synthesize empty text.');
		}

		let response: Response;
		try {
			response = await this.requestTts(
				trimmed,
				config,
				config.ttsModel,
				OPENROUTER_TTS_ENDPOINTS[0],
				signal
			);
		} catch (error) {
			throw new OpenRouterAudioError('Failed to reach OpenRouter TTS endpoint.', undefined, error);
		}

		if (!response.ok) {
			// Retry matrix: each endpoint x each candidate model
			const modelCandidates = [config.ttsModel, ...OPENROUTER_TTS_FALLBACK_MODELS].filter(
				(model, idx, arr) => arr.indexOf(model) === idx
			);
			let lastErrorMessage = '';
			let recovered = false;

			for (const endpoint of OPENROUTER_TTS_ENDPOINTS) {
				for (const model of modelCandidates) {
					try {
						const retryResponse = await this.requestTts(trimmed, config, model, endpoint, signal);
						if (retryResponse.ok) {
							response = retryResponse;
							recovered = true;
							break;
						}
						lastErrorMessage = await retryResponse.text().catch(() => retryResponse.statusText);
					} catch (error) {
						lastErrorMessage = error instanceof Error ? error.message : String(error);
					}
				}
				if (recovered) break;
			}

			if (!recovered) {
				throw new OpenRouterAudioError(
					`OpenRouter TTS request failed (${response.status}): ${lastErrorMessage || response.statusText}`,
					response.status
				);
			}
		}

		const blob = await response.blob();
		if (!blob.size) {
			throw new OpenRouterAudioError('OpenRouter TTS returned an empty audio payload.');
		}
		return blob;
	}
}
