// Renders a project's chat/prompt history as a plain-text log that gets committed
// to the user's GitHub repo at .yield/prompts.txt — a portable, timestamped record
// of every prompt + reply, so the conversation can be called back to later.

export interface LogMessage {
  role: string;
  content: string;
  model?: string | null;
  flagged?: number | boolean;
  created_at: number; // unix seconds
}

// "2026-06-20 09:55:00 UTC"
export function fmtTime(unixSeconds: number): string {
  return new Date((unixSeconds || 0) * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC');
}

export function renderPromptLog(title: string, messages: LogMessage[]): string {
  const out: string[] = [
    `Yield — prompt history for "${title || 'Untitled app'}"`,
    `A timestamped record of this app's conversation (UTC). Oldest first.`,
    `Saved automatically by Yield on every build.`,
    '='.repeat(64),
    '',
  ];
  for (const m of messages) {
    const who =
      m.role === 'user' ? 'YOU'
      : m.role === 'assistant' ? `YIELD${m.model ? ` (${m.model})` : ''}`
      : (m.role || '').toUpperCase();
    const flag = m.flagged ? '  [blocked by safety guard]' : '';
    out.push(`[${fmtTime(m.created_at)}] ${who}${flag}`);
    out.push((m.content || '').trim() || '(no message)');
    out.push('');
  }
  return out.join('\n');
}
