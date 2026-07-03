import { type ReactNode, useCallback } from 'react';
import { toast as sonnerToast } from 'sonner';
import { Toaster } from './sonner';
import { ToastContext } from './toast-context';

export function ToastProvider({ children }: { children: ReactNode }) {
  const toast = useCallback(
    (message: string, type: 'success' | 'error' = 'success') => {
      if (type === 'error') {
        sonnerToast.error(message);
        return;
      }
      sonnerToast.success(message);
    },
    []
  );

  return (
    <ToastContext value={{ toast }}>
      {children}
      <Toaster />
    </ToastContext>
  );
}
