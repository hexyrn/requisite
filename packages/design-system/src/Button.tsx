import React from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const variantStyles: Record<ButtonVariant, React.CSSProperties> = {
  primary: { background: '#1f4b99', color: '#fff', border: '1px solid #1f4b99' },
  secondary: { background: '#fff', color: '#1f4b99', border: '1px solid #1f4b99' },
  danger: { background: '#b3261e', color: '#fff', border: '1px solid #b3261e' },
};

export function Button({ variant = 'primary', style, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      style={{
        padding: '8px 16px',
        borderRadius: 4,
        cursor: rest.disabled ? 'not-allowed' : 'pointer',
        fontSize: 14,
        opacity: rest.disabled ? 0.6 : 1,
        ...variantStyles[variant],
        ...style,
      }}
    />
  );
}
