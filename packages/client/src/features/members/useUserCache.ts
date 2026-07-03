import { useApiClient } from '@deploykit/client';
import { useCallback, useRef } from 'react';

interface CachedUser {
  id: string;
  name: string;
  email: string;
}

/**
 * Simple in-memory user cache. Fetches user info lazily and caches results
 * so repeated lookups don't trigger extra API calls.
 */
export function useUserCache() {
  const api = useApiClient();
  const cache = useRef<Map<string, CachedUser>>(new Map());

  const getUser = useCallback(
    async (userId: string): Promise<CachedUser | null> => {
      if (cache.current.has(userId)) {
        return cache.current.get(userId) ?? null;
      }
      // Search the users list by constructing a search that matches the userId
      // For now, list all projects and find the user from the data
      // In the future, add a dedicated GET /api/users/:id endpoint
      try {
        const projects = await api.listProjects();
        // Look through all projects' members to find user info
        // This is a temporary approach — a dedicated endpoint would be better
        for (const p of projects) {
          if (p.createdBy === userId) {
            // We don't have the name from here, use what we can
            const user = { id: userId, name: userId, email: '' };
            cache.current.set(userId, user);
            return user;
          }
        }
      } catch {
        return null;
      }
      return null;
    },
    [api],
  );

  const setUser = useCallback((user: CachedUser) => {
    cache.current.set(user.id, user);
  }, []);

  return { getUser, setUser };
}
