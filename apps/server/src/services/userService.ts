import { randomBytes } from 'node:crypto';
import type { SafeUser, User } from '@deploykit/shared';
import { ApiError, ErrorCode } from '../errors';
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

    createUser({ name, email, password, role }) {
      const normalizedEmail = email.toLowerCase();
      const passwordHash = Bun.password.hashSync(password);
      return repo.mutate((data) => {
        if (
          data.users.some(
            (user) => user.email.toLowerCase() === normalizedEmail
          )
        ) {
          throw new ApiError(
            ErrorCode.EMAIL_ALREADY_EXISTS,
            'Email is already registered',
            400
          );
        }
        const now = new Date().toISOString();
        const user: User = {
          id: createId(),
          name,
          email: normalizedEmail,
          passwordHash,
          role,
          createdAt: now,
          updatedAt: now,
        };
        data.users.push(user);
        return toSafeUser(user);
      });
    },

    searchByEmail(query) {
      if (!query || query.length < 2) return [];
      const lower = query.toLowerCase();
      return repo
        .load()
        .users.filter((u) => u.email.toLowerCase().includes(lower))
        .slice(0, 10)
        .map((u) => toSafeUser(u));
    },

    seedAdminIfMissing(email, password) {
      const plain = password || generatePassword();
      const passwordHash = Bun.password.hashSync(plain);
      return repo.mutate((data) => {
        if (data.users.some((user) => user.role === 'admin')) return null;

        const now = new Date().toISOString();
        data.users.push({
          id: createId(),
          name: 'Admin',
          email: email.toLowerCase(),
          passwordHash,
          role: 'admin',
          createdAt: now,
          updatedAt: now,
        });
        return plain;
      });
    },
  };
}
