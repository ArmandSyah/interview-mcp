import { useLayoutEffect, useRef, type ComponentPropsWithoutRef } from 'react';

type Props = Pick<
  ComponentPropsWithoutRef<'dialog'>,
  'children' | 'className' | 'aria-label' | 'aria-labelledby'
> & {
  onDismiss: () => void;
  canDismiss?: boolean;
  dismissOnBackdrop?: boolean;
  returnFocus?: HTMLElement | null;
};

/** A native modal keeps keyboard and pointer input out of the background workspace. */
export function Modal({
  children,
  className = '',
  onDismiss,
  canDismiss = true,
  dismissOnBackdrop = false,
  returnFocus,
  ...label
}: Props) {
  const element = useRef<HTMLDialogElement>(null);
  const outsidePress = useRef(false);
  useLayoutEffect(() => {
    const dialog = element.current!;
    // An asynchronous open can disable the opener before this dialog mounts.
    const previous = returnFocus ?? document.activeElement;
    // Repeated native close requests can bypass cancel.preventDefault().
    // Keep dismissal under application control until draft writes finish.
    dialog.setAttribute('closedby', 'none');
    dialog.showModal();
    return () => {
      dialog.close();
      // Wait for React to enable the opener after an asynchronous close.
      requestAnimationFrame(() => {
        if (
          previous instanceof HTMLElement &&
          previous.isConnected &&
          (document.activeElement === document.body || document.activeElement === previous) &&
          !document.querySelector('dialog[open]')
        )
          previous.focus();
      });
    };
  }, [returnFocus]);
  useLayoutEffect(() => {
    const dialog = element.current!;
    // A disabled form control can move focus to the document body.
    const active = document.activeElement;
    if (dialog.open && (!dialog.contains(active) || active?.matches(':disabled'))) dialog.focus();
  }, [canDismiss]);
  const outside = (x: number, y: number) => {
    const bounds = element.current!.getBoundingClientRect();
    return x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom;
  };
  return (
    <dialog
      {...label}
      ref={element}
      className={`modal-dialog ${className}`}
      aria-modal="true"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing)
          return;
        event.preventDefault();
        event.stopPropagation();
        if (canDismiss) onDismiss();
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (canDismiss) onDismiss();
      }}
      onPointerDown={(event) => {
        outsidePress.current =
          event.target === event.currentTarget && outside(event.clientX, event.clientY);
      }}
      onClick={(event) => {
        if (
          dismissOnBackdrop &&
          canDismiss &&
          outsidePress.current &&
          event.target === event.currentTarget &&
          outside(event.clientX, event.clientY)
        )
          onDismiss();
        outsidePress.current = false;
      }}
    >
      {children}
    </dialog>
  );
}
