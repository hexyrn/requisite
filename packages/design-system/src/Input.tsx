import React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, id, style, ...rest }: InputProps) {
  const inputId = id ?? rest.name;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
      {label && (
        <label htmlFor={inputId} style={{ fontSize: 13, fontWeight: 600, color: '#333' }}>
          {label}
        </label>
      )}
      <input
        id={inputId}
        {...rest}
        style={{
          padding: '8px 10px',
          borderRadius: 4,
          border: error ? '1px solid #b3261e' : '1px solid #ccc',
          fontSize: 14,
          ...style,
        }}
      />
      {error && <span style={{ color: '#b3261e', fontSize: 12 }}>{error}</span>}
    </div>
  );
}
