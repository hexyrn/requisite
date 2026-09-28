import React from 'react';

export function Card({ children, className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={['hx-card', className ?? ''].filter(Boolean).join(' ')}>
      {children}
    </div>
  );
}
