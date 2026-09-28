import React from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Stretch to the full width of the container. */
  block?: boolean;
}

export function Button({ variant = 'primary', block, className, ...rest }: ButtonProps) {
  const classes = ['hx-btn', `hx-btn--${variant}`, block ? 'hx-btn--block' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return <button {...rest} className={classes} />;
}
