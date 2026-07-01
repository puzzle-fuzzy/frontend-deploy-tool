import { CheckCircle2, X, XCircle } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ToastContext } from './toast-context';

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error';
}

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(
    new Map()
  );

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
    // Clear the timer if it exists
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (message: string, type: 'success' | 'error' = 'success') => {
      const id = nextId++;
      setToasts((prev) => [...prev, { id, message, type }]);
      const timer = setTimeout(() => dismiss(id), 3000);
      timersRef.current.set(id, timer);
    },
    [dismiss]
  );

  // Cleanup all timers on unmount
  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => {
        clearTimeout(timer);
      });
      timersRef.current.clear();
    };
  }, []);

  return (
    <ToastContext value={{ toast }}>
      {children}
      <div className="fixed bottom-6 right-6 z-(--z-toast) flex flex-col gap-2">
        {toasts.map((entry) => (
          <div
            key={entry.id}
            // `role=status`/`alert` + `aria-live` so screen readers announce new
            // toasts; errors are assertive, success is polite.
            role={entry.type === 'error' ? 'alert' : 'status'}
            aria-live={entry.type === 'error' ? 'assertive' : 'polite'}
            className={`flex items-center gap-2 pe-2 px-4 py-2.5 rounded-lg shadow-lg text-sm transition-all animate-in slide-in-from-right-5 fade-in duration-300 ${
              entry.type === 'success'
                ? 'bg-primary text-primary-foreground'
                : 'bg-destructive text-white'
            }`}
          >
            {entry.type === 'success' ? (
              <CheckCircle2 className="size-4 shrink-0" aria-hidden />
            ) : (
              <XCircle className="size-4 shrink-0" aria-hidden />
            )}
            <span className="flex-1">{entry.message}</span>
            <button
              type="button"
              onClick={() => dismiss(entry.id)}
              aria-label={t('common.close')}
              className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-current focus-visible:ring-offset-1 transition-opacity"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastContext>
  );
}
