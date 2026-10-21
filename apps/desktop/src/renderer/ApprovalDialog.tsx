import { useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { Approval } from '../shared/types';
import { Modal } from './Modal';

type Props = {
  approval: Approval;
  closing: boolean;
  onResolved: (id: string) => void;
};

/** Mount a different dialog for each approval ID. Chat owns the shared action lock. */
export function ApprovalDialog({ approval, closing, onResolved }: Props) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function decide(allow: boolean) {
    if (pending.current || closing) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await window.interview.approve(approval.id, allow);
      onResolved(approval.id);
    } catch (error) {
      setError(
        (error instanceof Error ? error.message : 'Cannot send the approval decision').replace(
          /^Error invoking remote method '[^']+': Error: /,
          '',
        ),
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      className="approval-modal"
      aria-labelledby="approval-title"
      canDismiss={!busy && !closing}
      onDismiss={() => void decide(false)}
    >
      <ShieldCheck size={28} />
      <h2 id="approval-title">Approve submission?</h2>
      <p>{approval.description}</p>
      {error && <p role="alert">{error}</p>}
      <div>
        <button className="secondary" disabled={busy || closing} onClick={() => void decide(false)}>
          Keep practicing
        </button>
        <button className="primary" disabled={busy || closing} onClick={() => void decide(true)}>
          Submit this draft
        </button>
      </div>
    </Modal>
  );
}
