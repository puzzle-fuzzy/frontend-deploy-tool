import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Input } from '@/shared/ui/input';
import { Textarea } from '@/shared/ui/textarea';
import { useToast } from '@/shared/ui/toast-context';
import { normalizeProjectSlugInput } from './slug';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

export function CreateProjectDialog({ open, onOpenChange, onCreated }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const nameInputId = 'create-project-name';
  const slugInputId = 'create-project-slug';
  const descInputId = 'create-project-description';
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [desc, setDesc] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) return;
    setName('');
    setSlug('');
    setDesc('');
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !slug.trim()) return;
    setSubmitting(true);
    try {
      await api.createProject({
        name: name.trim(),
        slug: slug.trim(),
        description: desc.trim(),
      });
      toast(t('common.created'));
      setName('');
      setSlug('');
      setDesc('');
      onCreated();
      onOpenChange(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : t('common.failed'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('create.title')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor={nameInputId}
              className="text-sm font-medium text-muted-foreground"
            >
              {t('create.name')}
            </label>
            <Input
              id={nameInputId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('create.namePlaceholder')}
            />
          </div>
          <div className="space-y-2">
            <label
              htmlFor={slugInputId}
              className="text-sm font-medium text-muted-foreground"
            >
              {t('create.slug')}
            </label>
            <Input
              id={slugInputId}
              value={slug}
              onChange={(e) =>
                setSlug(normalizeProjectSlugInput(e.target.value))
              }
              placeholder={t('create.slugPlaceholder')}
              className="font-mono"
            />
            <p className="text-sm text-muted-foreground">
              {t('create.slugHint')}
            </p>
          </div>
          <div className="space-y-2">
            <label
              htmlFor={descInputId}
              className="text-sm font-medium text-muted-foreground"
            >
              {t('create.description')}
            </label>
            <Textarea
              id={descInputId}
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder={t('create.descPlaceholder')}
              rows={2}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="default"
              type="button"
              onClick={() => onOpenChange(false)}
            >
              {t('create.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={submitting || !name.trim() || !slug.trim()}
              size="default"
            >
              {t('create.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
