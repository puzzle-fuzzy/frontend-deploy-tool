import { CheckCircle2, XCircle } from 'lucide-react';
import { type ReactNode, useCallback, useState } from 'react';
import { ToastContext } from './toast-context';

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error';
}

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback(
    (message: string, type: 'success' | 'error' = 'success') => {
      const id = nextId++;
      setToasts((prev) => [...prev, { id, message, type }]);
      setTimeout(
        () => setToasts((prev) => prev.filter((t) => t.id !== id)),
        3000
      );
    },
    []
  );

  return (
    <ToastContext value={{ toast }}>
      {children}
      <div className="fixed bottom-6 right-6 z-100 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-lg text-sm transition-all animate-in slide-in-from-right-5 fade-in duration-300 ${
              t.type === 'success'
                ? 'bg-primary text-primary-foreground'
                : 'bg-destructive text-white'
            }`}
          >
            {t.type === 'success' ? (
              <CheckCircle2 className="size-4" />
            ) : (
              <XCircle className="size-4" />
            )}
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext>
  );
}
