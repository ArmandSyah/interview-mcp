import { useRef, useState } from 'react';

/** Stop is independent of the action lock because the chat owns that lock. */
export function useChatStop(chatId: string | null, reportError: (message: string) => void) {
  const currentId = useRef(chatId);
  currentId.current = chatId;
  const pending = useRef(new Set<string>());
  const [, render] = useState(0);
  async function stop() {
    if (!chatId || pending.current.has(chatId)) return;
    pending.current.add(chatId);
    render((value) => value + 1);
    reportError('');
    try {
      await window.interview.cancelChat(chatId);
    } catch (error) {
      if (currentId.current === chatId)
        reportError(
          (error instanceof Error ? error.message : 'Cannot stop the coach').replace(
            /^Error invoking remote method '[^']+': Error: /,
            '',
          ),
        );
    } finally {
      pending.current.delete(chatId);
      render((value) => value + 1);
    }
  }
  return { stop, stopping: !!chatId && pending.current.has(chatId) };
}
