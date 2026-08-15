export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  kind: ToastKind;
  message: string;
}

const listeners = new Set<(toast: Toast) => void>();

/** Show a toast. This already exists — the vendor form just never shows one for duplicates. */
export function showToast(kind: ToastKind, message: string): void {
  const toast: Toast = { kind, message };
  for (const listener of listeners) listener(toast);
}

export function onToast(listener: (toast: Toast) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
