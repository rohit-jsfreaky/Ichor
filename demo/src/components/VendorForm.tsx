'use client';

import { useState } from 'react';
import { submitVendor } from '../lib/vendors/submit';
import type { NewVendor } from '../lib/vendors/create';

const EMPTY: NewVendor = { company: '', name: '', email: '', address: '', phone: '' };

/**
 * Vendor onboarding form — the entry point of the demo scenario.
 *
 * 🐛 Part of the demo bug: on any failure the form is reset, so a user who
 * simply typed an email that already exists loses everything they entered.
 */
export function VendorForm() {
  const [values, setValues] = useState<NewVendor>(EMPTY);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);

    const result = await submitVendor(values);

    // Wipes the form even on a recoverable duplicate-email failure.
    if (!result.ok) setValues(EMPTY);
    setBusy(false);
  }

  function set(field: keyof NewVendor, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  return (
    <form onSubmit={handleSubmit}>
      <input value={values.company} onChange={(e) => set('company', e.target.value)} placeholder="Company" />
      <input value={values.name} onChange={(e) => set('name', e.target.value)} placeholder="Contact name" />
      <input value={values.email} onChange={(e) => set('email', e.target.value)} placeholder="Email" />
      <input value={values.address ?? ''} onChange={(e) => set('address', e.target.value)} placeholder="Address" />
      <input value={values.phone ?? ''} onChange={(e) => set('phone', e.target.value)} placeholder="Phone" />
      <button type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Add vendor'}
      </button>
    </form>
  );
}
