import { identicon } from '@dicebear/collection';
import { createAvatar } from '@dicebear/core';

export function getUserAvatarUrl(userId: string): string {
  const avatar = createAvatar(identicon, { seed: userId });
  return avatar.toDataUri();
}

export function getUserInitials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}
