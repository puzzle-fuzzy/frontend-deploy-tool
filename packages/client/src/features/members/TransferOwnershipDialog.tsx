import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../shared/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../shared/ui/select';
import { useToast } from '../../shared/ui/toast-context';

interface MemberOption {
  userId: string;
  name: string;
}

interface Props {
  open: boolean;
  members: MemberOption[];
  onTransfer: (targetUserId: string) => Promise<void>;
  onClose: () => void;
}

export function TransferOwnershipDialog({
  open,
  members,
  onTransfer,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);

  const handleTransfer = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await onTransfer(selected);
      toast(t('common.saved'));
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('common.failed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('members.transferTitle')}</DialogTitle>
        </DialogHeader>
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger>
            <SelectValue placeholder={t('members.selectTarget')} />
          </SelectTrigger>
          <SelectContent>
            {members.map((m) => (
              <SelectItem key={m.userId} value={m.userId}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleTransfer} disabled={busy || !selected}>
            {busy ? t('common.loading') : t('members.transfer')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
