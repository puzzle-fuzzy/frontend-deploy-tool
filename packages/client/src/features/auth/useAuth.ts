import { useApiClient } from '@deploykit/client';
import { useCallback, useEffect, useState } from 'react';
import type { SafeUser } from '@/shared/types';

export function useAuth() {
  const api = useApiClient();
  const [user, setUser] = useState<SafeUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getMe()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [api]);

  const login = useCallback(
    async (email: string, password: string) => {
      const next = await api.login(email, password);
      setUser(next);
      return next;
    },
    [api]
  );

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, [api]);

  return { user, loading, login, logout };
}
