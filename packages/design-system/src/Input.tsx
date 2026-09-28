import React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, id, className, ...rest }: InputProps) {
  // Accessibility (item 23): a label must always be programmatically
  // associated with its control, not just visually adjacent - falling
  // back to `rest.name` left inputs with neither `id` nor `name` (common
  // for fast-editing table-style rows) with NO htmlFor at all. A stable
  // generated id closes that gap unconditionally.
  const generatedId = React.useId();
  const inputId = id ?? rest.name ?? generatedId;
  const errorId = `${inputId}-error`;
  return (
    <div className="hx-field">
      {label && <label htmlFor={inputId}>{label}</label>}
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...rest}
        className={[error ? 'hx-field__input--error' : '', className ?? '']
          .filter(Boolean)
          .join(' ')}
      />
      {error && (
        <span id={errorId} className="hx-field__error">
          {error}
        </span>
      )}
    </div>
  );
}
