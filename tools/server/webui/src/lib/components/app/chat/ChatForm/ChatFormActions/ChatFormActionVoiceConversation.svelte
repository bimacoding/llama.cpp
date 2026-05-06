<script lang="ts">
	import { AudioLines } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';

	interface Props {
		disabled?: boolean;
		onclick?: (e: MouseEvent) => void;
	}

	let { disabled = false, onclick }: Props = $props();
</script>

<Tooltip.Root>
	<Tooltip.Trigger>
		<Button
			class="voice-conversation-button h-8 w-8 rounded-full p-0"
			{disabled}
			{onclick}
			variant="secondary"
			type="button"
		>
			<span class="sr-only">Start voice conversation</span>

			<AudioLines class="h-4 w-4" />
		</Button>
	</Tooltip.Trigger>

	<Tooltip.Content>
		<p>Start voice conversation</p>
	</Tooltip.Content>
</Tooltip.Root>
