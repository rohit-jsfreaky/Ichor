import { showToast } from '../ui/toast';
import type { NewVendor } from './create';

export interface SubmitResult {
  ok: boolean;
  /** Kept so the caller can decide whether to preserve the form. */
  retryable: boolean;
}

/**
 * Client-side submit for the vendor onboarding form.
 *
 * 🐛 Part of the demo bug: the server answers 500 for a duplicate email, so this
 * falls into the generic branch, shows "Something went wrong", and the caller
 * clears the form because it treats the failure as unrecoverable.
 */
export async function submitVendor(input: NewVendor): Promise<SubmitResult> {
  const response = await fetch('/api/vendors', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (response.ok) {
    showToast('success', 'Vendor created.');
    return { ok: true, retryable: false };
  }

  // Everything non-2xx is treated the same, including the duplicate-email case
  // that should be a friendly, recoverable message.
  showToast('error', 'Something went wrong');
  return { ok: false, retryable: false };
}
