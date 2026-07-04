import { useApiClient } from '@deploykit/client';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast-context';
import { getLocalizedError } from '../../shared/error-messages';
import { normalizeProjectSlugInput } from './slug';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

export function CreateProjectDialog({ open, onOpenChange, onCreated }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const api = useApiClient();
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
      toast(getLocalizedError(err, t, t('common.failed')), 'error');
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
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={nameInputId}>{t('create.name')}</FieldLabel>
              <Input
                id={nameInputId}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('create.namePlaceholder')}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={slugInputId}>{t('create.slug')}</FieldLabel>
              <Input
                id={slugInputId}
                value={slug}
                onChange={(e) =>
                  setSlug(normalizeProjectSlugInput(e.target.value))
                }
                placeholder={t('create.slugPlaceholder')}
                className="font-mono"
              />
              <FieldDescription>{t('create.slugHint')}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={descInputId}>
                {t('create.description')}
              </FieldLabel>
              <Textarea
                id={descInputId}
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder={t('create.descPlaceholder')}
                rows={2}
              />
            </Field>
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
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
