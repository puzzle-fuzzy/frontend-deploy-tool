import { useCallback, useEffect, useState } from 'react';
import { api } from '@/shared/api';
import type { SafeUser } from '@/shared/types';

/**
 * Owns the authenticated session: loads `/api/me` on mount, exposes
 * `login`/`logout`, and the current user (null when unauthenticated).
 */
export function useAuth() {
  const [user, setUser] = useState<SafeUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getMe()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const next = await api.login(email, password);
    setUser(next);
    return next;
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  return { user, loading, login, logout };
}
