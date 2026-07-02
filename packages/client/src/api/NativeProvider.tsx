import { createContext, type ReactNode, useContext } from 'react';
import type { NativeBridge } from './NativeBridge';

const NativeContext = createContext<NativeBridge | null>(null);

export function NativeProvider({
  bridge,
  children,
}: {
  bridge: NativeBridge | null;
  children: ReactNode;
}) {
  return (
    <NativeContext.Provider value={bridge}>{children}</NativeContext.Provider>
  );
}

/** Returns the native bridge, or null in the web app. */
export function useNative(): NativeBridge | null {
  return useContext(NativeContext);
}
