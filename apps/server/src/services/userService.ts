import { randomBytes } from 'node:crypto';
import type { SafeUser, User } from '@deploykit/shared';
import type { ProjectRepository } from '../repositories/projectRepository';
import { createId } from '../utils/id';
import type { UserService } from './contracts';

export type { UserService } from './contracts';

/** Strips the password hash before returning a user over the API. */
function toSafeUser(user: User): SafeUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/** Generates a random alphanumeric password (used when none is configured). */
function generatePassword(length = 16): string {
  return randomBytes(length).toString('base64url').slice(0, length);
}

export function createUserService(repo: ProjectRepository): UserService {
  return {
    findByEmail(email) {
      const normalized = email.toLowerCase();
      return repo
        .load()
        .users.find((u) => u.email.toLowerCase() === normalized);
    },

    getSafeUser(id) {
      const user = repo.load().users.find((u) => u.id === id);
      return user ? toSafeUser(user) : undefined;
    },

    async verifyCredentials(email, password) {
      const normalized = email.toLowerCase();
      const user = repo
        .load()
        .users.find((u) => u.email.toLowerCase() === normalized);
      if (!user) return null;
      const ok = await Bun.password.verify(password, user.passwordHash);
      return ok ? toSafeUser(user) : null;
    },

    seedAdminIfMissing(email, password) {
      const data = repo.load();
      if (data.users.length > 0) return null;

      const plain = password || generatePassword();
      const now = new Date().toISOString();
      data.users.push({
        id: createId(),
        name: 'Admin',
        email,
        passwordHash: Bun.password.hashSync(plain),
        role: 'admin',
        createdAt: now,
        updatedAt: now,
      });
      repo.save(data);
      return plain;
    },
  };
}
