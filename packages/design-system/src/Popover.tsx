import React from 'react';

export interface PopoverProps {
  /** Accessible name of the trigger button. */
  label: string;
  /** Visible content of the trigger button (an icon, a name...). */
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: 'left' | 'right';
  /** Extra class for the trigger button. */
  triggerClassName?: string;
}

/**
 * Small accessible popover: toggles on click, closes on Escape, on a click
 * outside, and after a link/button inside it is activated (menus navigate).
 */
export function Popover({
  label,
  trigger,
  children,
  align = 'right',
  triggerClassName = 'hx-icon-btn',
}: PopoverProps) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const panelId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="hx-popover" ref={rootRef}>
      <button
        type="button"
        className={triggerClassName}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={panelId}
          className={`hx-popover__panel${align === 'left' ? ' hx-popover__panel--left' : ''}`}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('a,button')) setOpen(false);
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
