import { useApiClient } from '@deploykit/client';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedError } from '../../shared/error-messages';
import { Button } from '../../shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../shared/ui/dialog';
import { Input } from '../../shared/ui/input';
import { useToast } from '../../shared/ui/toast-context';

interface Props {
  open: boolean;
  projectId: string;
  onAdded: () => void;
  onClose: () => void;
}

export function AddMemberDialog({ open, projectId, onAdded, onClose }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const api = useApiClient();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);

  const handleAdd = useCallback(async () => {
    if (!email.trim()) return;
    setLoading(true);
    try {
      await api.addMember(projectId, email.trim(), 'member');
      toast(t('common.saved'));
      setEmail('');
      onAdded();
      onClose();
    } catch (err) {
      toast(getLocalizedError(err, t, t('common.failed')), 'error');
    } finally {
      setLoading(false);
    }
  }, [email, projectId, api, toast, t, onAdded, onClose]);

  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('members.addTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Input
            placeholder={t('members.searchPlaceholder')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleAdd();
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleAdd} disabled={loading || !email.trim()}>
            {loading ? t('common.loading') : t('members.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
