<script lang="ts">
	import { Mic, Square, Loader2, X, AudioLines, AlertCircle } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { useVoiceConversation } from '$lib/hooks/use-voice-conversation.svelte';
	import { config } from '$lib/stores/settings.svelte';
	import { tick } from 'svelte';

	interface Props {
		open: boolean;
	}

	let { open = $bindable() }: Props = $props();

	const voice = useVoiceConversation();

	let transcriptContainer: HTMLDivElement | undefined = $state(undefined);
	let isStarting = $state(false);
	let hasApiKey = $derived(Boolean(String(config().voiceApiKey ?? '').trim()));

	$effect(() => {
		if (open) {
			void voice.transcript;
			tick().then(() => {
				if (transcriptContainer) {
					transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
				}
			});
		}
	});

	$effect(() => {
		if (open && voice.phase === 'idle' && !voice.errorMessage && !isStarting) {
			isStarting = true;
			void voice.start().finally(() => {
				isStarting = false;
			});
		}
	});

	async function handleMicClick() {
		// Reuse this user gesture to retry pending autoplay-blocked audio first.
		await voice.onUserGesture();

		if (voice.phase === 'speaking') {
			return;
		}

		if (voice.phase === 'listening') {
			await voice.stopRecording();
		} else if (voice.phase === 'idle') {
			isStarting = true;
			try {
				await voice.start();
			} finally {
				isStarting = false;
			}
		}
	}

	async function handlePlayResponse() {
		await voice.playPendingAudio();
	}

	function handleEnd() {
		voice.end();
		open = false;
	}

	function handleOpenChange(newOpen: boolean) {
		if (!newOpen) {
			voice.end();
			open = false;
		} else {
			open = true;
		}
	}

	let phaseLabel = $derived.by(() => {
		switch (voice.phase) {
			case 'listening':
				return 'Listening…';
			case 'processing_stt':
				return 'Transcribing speech…';
			case 'sending_llm':
				return 'Thinking…';
			case 'processing_tts':
				return 'Generating voice…';
			case 'speaking':
				return 'Speaking…';
			case 'awaiting_playback':
				return 'Tap to play response audio';
			default:
				return 'Voice conversation';
		}
	});

	let micDisabled = $derived(
		!hasApiKey ||
			!voice.isSupported ||
			voice.phase === 'processing_stt' ||
			voice.phase === 'sending_llm' ||
			voice.phase === 'processing_tts' ||
			voice.phase === 'speaking' ||
			voice.phase === 'awaiting_playback'
	);
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="top-0 left-0 grid h-[100dvh] max-h-[100dvh] w-screen max-w-none translate-x-0 translate-y-0 grid-rows-[auto_1fr_auto] gap-0 overflow-hidden rounded-none border-0 bg-background p-0 sm:max-w-none"
		showCloseButton={false}
	>
		<header class="flex items-center justify-between border-b border-border/30 px-6 py-4">
			<div class="flex items-center gap-2">
				<AudioLines class="h-5 w-5 text-primary" />

				<Dialog.Title class="text-base font-semibold">Voice conversation</Dialog.Title>
			</div>

			<Dialog.Description class="sr-only">
				Speak to the assistant. Your voice is transcribed and the response is read back to you.
			</Dialog.Description>

			<Button
				variant="ghost"
				size="sm"
				class="h-8 w-8 rounded-full p-0"
				onclick={handleEnd}
				type="button"
			>
				<X class="h-4 w-4" />

				<span class="sr-only">End voice conversation</span>
			</Button>
		</header>

		<section class="flex flex-col items-center gap-6 overflow-hidden px-6 py-6 md:px-12">
			{#if !hasApiKey}
				<div
					class="flex w-full max-w-2xl items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm"
				>
					<AlertCircle class="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />

					<div>
						<p class="font-medium">OpenRouter API key required</p>

						<p class="mt-1 text-muted-foreground">
							Configure your OpenRouter API key in Settings → General → Voice Conversation to enable
							speech-to-text and text-to-speech.
						</p>
					</div>
				</div>
			{/if}

			{#if voice.errorMessage}
				<div
					class="flex w-full max-w-2xl items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm"
				>
					<AlertCircle class="mt-0.5 h-5 w-5 shrink-0 text-destructive" />

					<p>{voice.errorMessage}</p>
				</div>
			{/if}

			<div class="relative flex h-32 w-32 items-center justify-center">
				<span
					class={[
						'absolute inset-0 rounded-full border-4 transition-all duration-300',
						voice.phase === 'listening' && 'animate-ping border-red-500/60',
						voice.phase === 'speaking' && 'animate-pulse border-primary/60',
						(voice.phase === 'processing_stt' ||
							voice.phase === 'sending_llm' ||
							voice.phase === 'processing_tts') &&
							'border-muted-foreground/30',
						voice.phase === 'idle' && 'border-muted-foreground/20'
					]}
				></span>

				<div
					class={[
						'flex h-24 w-24 items-center justify-center rounded-full transition-colors',
						voice.phase === 'listening' && 'bg-red-500 text-white',
						voice.phase === 'speaking' && 'bg-primary text-primary-foreground',
						voice.phase !== 'listening' && voice.phase !== 'speaking' && 'bg-muted text-foreground'
					]}
				>
					{#if voice.phase === 'processing_stt' || voice.phase === 'sending_llm' || voice.phase === 'processing_tts'}
						<Loader2 class="h-10 w-10 animate-spin" />
					{:else if voice.phase === 'speaking'}
						<AudioLines class="h-10 w-10 animate-pulse" />
					{:else if voice.phase === 'listening'}
						<Mic class="h-10 w-10" />
					{:else}
						<Mic class="h-10 w-10" />
					{/if}
				</div>
			</div>

			<p class="text-center text-sm font-medium text-muted-foreground">{phaseLabel}</p>

			{#if voice.phase === 'awaiting_playback' || voice.hasPendingPlayback}
				<Button type="button" variant="default" onclick={handlePlayResponse}>
					Play response
				</Button>
			{/if}

			<div
				bind:this={transcriptContainer}
				class="flex h-full w-full max-w-2xl flex-1 flex-col gap-3 overflow-y-auto rounded-lg border border-border/30 bg-muted/30 p-4"
			>
				{#if voice.transcript.length === 0}
					<p class="m-auto text-center text-sm text-muted-foreground">
						Your voice transcript will appear here as you speak with the assistant.
					</p>
				{:else}
					{#each voice.transcript as entry (entry.id)}
						<div class={['flex', entry.role === 'user' ? 'justify-end' : 'justify-start']}>
							<div
								class={[
									'max-w-[85%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap',
									entry.role === 'user'
										? 'bg-primary text-primary-foreground'
										: 'border border-border/30 bg-background text-foreground'
								]}
							>
								{entry.text}
							</div>
						</div>
					{/each}
				{/if}
			</div>
		</section>

		<footer class="flex items-center justify-center gap-4 border-t border-border/30 px-6 py-4">
			<Button
				type="button"
				variant="secondary"
				class="h-12 w-12 rounded-full p-0"
				onclick={handleEnd}
			>
				<X class="h-5 w-5" />

				<span class="sr-only">End</span>
			</Button>

			<Button
				type="button"
				disabled={micDisabled}
				onclick={handleMicClick}
				class={[
					'h-16 w-16 rounded-full p-0',
					voice.phase === 'listening' && 'animate-pulse bg-red-500 text-white hover:bg-red-600'
				]}
			>
				{#if voice.phase === 'listening'}
					<Square class="h-6 w-6 fill-current" />
				{:else if voice.phase === 'processing_stt' || voice.phase === 'sending_llm' || voice.phase === 'processing_tts'}
					<Loader2 class="h-6 w-6 animate-spin" />
				{:else}
					<Mic class="h-6 w-6" />
				{/if}

				<span class="sr-only">
					{voice.phase === 'listening' ? 'Stop recording' : 'Start recording'}
				</span>
			</Button>

			<div class="h-12 w-12"></div>
		</footer>
	</Dialog.Content>
</Dialog.Root>
