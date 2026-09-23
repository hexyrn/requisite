import type { StatusTone } from '@hexyrn/design-system';

/** Maps backend ok/warn/error (and boolean valid/invalid) health-style statuses to a design-system StatusTone. */
export function toneForStatus(status: string): StatusTone {
  switch (status) {
    case 'ok':
    case 'success':
    case 'valid':
      return 'success';
    case 'warn':
    case 'warning':
      return 'warning';
    case 'error':
    case 'invalid':
    case 'danger':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function toneForBool(ok: boolean): StatusTone {
  return ok ? 'success' : 'danger';
}
