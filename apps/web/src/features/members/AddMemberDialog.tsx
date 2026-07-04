import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useApiClient } from '@/shared/api/context';

interface AddMemberDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}

export function AddMemberDialog({
  projectId,
  open,
  onOpenChange,
  onChanged,
}: AddMemberDialogProps) {
  const { t } = useTranslation();
  const api = useApiClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'owner'>('member');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await api.addMember(projectId, email.trim(), role);
      setEmail('');
      setRole('member');
      onChanged();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('members.addTitle')}</DialogTitle>
          <DialogDescription>{t('members.addDesc')}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('auth.email')}
            <Input
              type="email"
              value={email}
              placeholder={t('members.searchPlaceholder')}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('members.role')}
            <Select
              value={role}
              onValueChange={(value) =>
                setRole(value === 'owner' ? 'owner' : 'member')
              }
              disabled={submitting}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="member">{t('members.member')}</SelectItem>
                  <SelectItem value="owner">{t('members.owner')}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
          {error && (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={submitting || !email.trim()}>
              {submitting ? t('common.loading') : t('members.add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
