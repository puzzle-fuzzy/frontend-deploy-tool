import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApiClient } from '@/api/ApiClientProvider';
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
import { useToast } from '@/components/ui/toast-context';
import { getLocalizedError } from '@/shared/error-messages';

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
  const { toast } = useToast();
  const api = useApiClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'owner'>('member');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);

    try {
      await api.addMember(projectId, email.trim(), role);
      setEmail('');
      setRole('member');
      toast(t('common.saved'));
      onChanged();
      onOpenChange(false);
    } catch (err) {
      toast(getLocalizedError(err, t, t('common.failed')), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="grid gap-0 border-b sm:grid-cols-[8rem_1fr]">
          <div className="border-b bg-primary p-5 text-primary-foreground sm:border-b-0 sm:border-r">
            <span className="editorial-number text-5xl">02</span>
            <span className="editorial-meta mt-16 block text-primary-foreground/65">
              Member
            </span>
          </div>
          <div className="p-6">
            <span className="editorial-meta text-primary">Access / Invite</span>
            <DialogTitle className="mt-4 text-3xl font-normal tracking-[-0.05em]">
              {t('members.addTitle')}
            </DialogTitle>
            <DialogDescription className="mt-3 leading-relaxed">
              {t('members.addDesc')}
            </DialogDescription>
          </div>
        </DialogHeader>
        <form className="flex flex-col gap-5 p-6" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <label
              htmlFor="member-email"
              className="editorial-meta text-muted-foreground"
            >
              {t('auth.email')}
            </label>
            <Input
              id="member-email"
              type="email"
              value={email}
              placeholder={t('members.searchPlaceholder')}
              onChange={(event) => setEmail(event.target.value)}
              className="h-12"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <label
              htmlFor="member-role"
              className="editorial-meta text-muted-foreground"
            >
              {t('members.role')}
            </label>
            <Select
              value={role}
              onValueChange={(value) =>
                setRole(value === 'owner' ? 'owner' : 'member')
              }
              disabled={submitting}
            >
              <SelectTrigger id="member-role" className="h-12 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="member">{t('members.member')}</SelectItem>
                  <SelectItem value="owner">{t('members.owner')}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter className="mx-0 -mb-6 rounded-none border-t bg-muted p-5 sm:-mx-6">
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
