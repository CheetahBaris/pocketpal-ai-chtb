import type {OpenAIChatMessage} from './openaiApi';

/** Flattens an OpenAI content field (string or text parts) into plain text. */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(part => part && typeof part === 'object')
      .filter(part => (part as {type?: unknown}).type === 'text')
      .map(part => String((part as {text?: unknown}).text ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Chat templates accept at most one leading system message. Fold the Pal
 * prompt and every client system message into it, keeping the rest in order.
 * With no prompt and no client system message the array is returned untouched.
 */
export function mergeSystemPrompt(
  messages: OpenAIChatMessage[],
  systemPrompt: string,
): OpenAIChatMessage[] {
  const clientSystem = messages
    .filter(message => message.role === 'system')
    .map(message => contentToText(message.content))
    .filter(part => part.trim().length > 0);
  const parts = [systemPrompt.trim(), ...clientSystem].filter(
    part => part.length > 0,
  );

  if (parts.length === 0) {
    return messages;
  }

  const rest = messages.filter(message => message.role !== 'system');
  return [{role: 'system', content: parts.join('\n\n')}, ...rest];
}
