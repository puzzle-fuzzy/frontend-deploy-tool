import { createContext, useContext } from 'react';

export interface ToastContextValue {
  toast: (message: string, type?: 'success' | 'error') => void;
}

export const ToastContext = createContext<ToastContextValue>({
  toast: () => {},
});

export const useToast = () => useContext(ToastContext);
