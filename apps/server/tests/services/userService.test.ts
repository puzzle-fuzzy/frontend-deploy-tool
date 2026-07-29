import { expect, test } from 'bun:test';
import type { Data } from '@deploykit/shared';
import type { ProjectRepository } from '../../src/repositories/projectRepository';
import { createUserService } from '../../src/services/userService';

test('seeds an admin when legacy data contains users but no administrator', () => {
  const data: Data = {
    schemaVersion: 5,
    projects: [],
    users: [
      {
        id: 'system',
        name: 'System',
        email: 'system@invalid.local',
        passwordHash: 'disabled',
        role: 'viewer',
        createdAt: '',
        updatedAt: '',
      },
    ],
    history: [],
  };
  const repo: ProjectRepository = {
    load: () => data,
    save: () => {},
    mutate: (operation) => operation(data),
  };

  const password = createUserService(repo).seedAdminIfMissing(
    'admin@example.com',
    'configured-password'
  );

  expect(password).toBe('configured-password');
  expect(data.users).toHaveLength(2);
  expect(data.users.find((user) => user.role === 'admin')?.email).toBe(
    'admin@example.com'
  );
});
