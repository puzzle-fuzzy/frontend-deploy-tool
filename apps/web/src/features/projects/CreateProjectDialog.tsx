import { useState, type FormEvent } from 'react';
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
import { useApiClient } from '@/shared/api/context';
import type { Project } from '@/shared/types';
import { normalizeProjectSlugInput } from './slug';

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: Project) => void;
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateProjectDialogProps) {
  const { t } = useTranslation();
  const api = useApiClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    name.trim().length > 0 && slug.trim().length > 0 && !submitting;

  const reset = () => {
    setName('');
    setSlug('');
    setDescription('');
    setError(null);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const project = await api.createProject({
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim(),
      });
      onCreated(project);
      reset();
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
          <DialogTitle>{t('create.title')}</DialogTitle>
          <DialogDescription>{t('create.desc')}</DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('create.name')}
            <Input
              value={name}
              placeholder={t('create.namePlaceholder')}
              onChange={(event) => {
                const next = event.target.value;
                setName(next);
                if (!slug) setSlug(normalizeProjectSlugInput(next));
              }}
              required
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('create.slug')}
            <Input
              value={slug}
              placeholder={t('create.slugPlaceholder')}
              onChange={(event) =>
                setSlug(normalizeProjectSlugInput(event.target.value))
              }
              required
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('create.description')}
            <Input
              value={description}
              placeholder={t('create.descPlaceholder')}
              onChange={(event) => setDescription(event.target.value)}
            />
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
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? t('common.creating') : t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
