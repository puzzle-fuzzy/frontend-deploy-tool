import { useEffect, useState } from 'react';
import { useApiClient } from '@/api/ApiClientProvider';
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

  const login = async (email: string, password: string) => {
    const next = await api.login(email, password);
    setUser(next);
    return next;
  };

  const register = async (input: {
    name: string;
    email: string;
    password: string;
  }) => {
    const next = await api.register(input);
    setUser(next);
    return next;
  };

  const logout = async () => {
    await api.logout();
    setUser(null);
  };

  return { user, loading, login, register, logout };
}
