import { createContext, type ReactNode, useContext } from 'react';

const ServerInfoContext = createContext<{ origin: string }>({ origin: '' });

export function ServerInfoProvider({
  origin,
  children,
}: {
  origin: string;
  children: ReactNode;
}) {
  return (
    <ServerInfoContext.Provider value={{ origin }}>
      {children}
    </ServerInfoContext.Provider>
  );
}

/** Server origin used to build deploy URLs etc. Web: publicBaseUrl; desktop: configured origin. */
export function useServerInfo(): { origin: string } {
  return useContext(ServerInfoContext);
}
