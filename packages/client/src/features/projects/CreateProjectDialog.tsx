import { ArrowRight } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast-context';
import { getLocalizedError } from '@/shared/error-messages';
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
  const { toast } = useToast();
  const api = useApiClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit =
    name.trim().length > 0 && slug.trim().length > 0 && !submitting;

  const reset = () => {
    setName('');
    setSlug('');
    setDescription('');
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);

    try {
      const project = await api.createProject({
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim(),
      });
      onCreated(project);
      toast(t('common.created'));
      reset();
      onOpenChange(false);
    } catch (err) {
      toast(getLocalizedError(err, t, t('common.failed')), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="grid gap-0 border-b sm:grid-cols-[9rem_1fr]">
          <div className="border-b bg-primary p-5 text-primary-foreground sm:border-b-0 sm:border-r">
            <span className="editorial-number text-6xl">01</span>
            <span className="editorial-meta mt-16 block text-primary-foreground/65">
              New target
            </span>
          </div>
          <div className="p-6 sm:p-8">
            <span className="editorial-meta text-primary">
              Project / Create
            </span>
            <DialogTitle className="mt-5 text-3xl font-normal tracking-[-0.05em]">
              {t('create.title')}
            </DialogTitle>
            <DialogDescription className="mt-3 max-w-md leading-relaxed">
              {t('create.desc')}
            </DialogDescription>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="grid gap-5 p-6 sm:grid-cols-2 sm:p-8">
            <ProjectField
              id="project-name"
              label={t('create.name')}
              className="sm:col-span-1"
            >
              <Input
                id="project-name"
                value={name}
                placeholder={t('create.namePlaceholder')}
                onChange={(event) => {
                  const next = event.target.value;
                  setName(next);
                  if (!slug) setSlug(normalizeProjectSlugInput(next));
                }}
                className="h-12"
                required
              />
            </ProjectField>

            <ProjectField id="project-slug" label={t('create.slug')}>
              <Input
                id="project-slug"
                value={slug}
                placeholder={t('create.slugPlaceholder')}
                onChange={(event) =>
                  setSlug(normalizeProjectSlugInput(event.target.value))
                }
                className="h-12 font-mono text-sm"
                required
              />
            </ProjectField>

            <ProjectField
              id="project-description"
              label={t('create.description')}
              className="sm:col-span-2"
            >
              <Textarea
                id="project-description"
                value={description}
                placeholder={t('create.descPlaceholder')}
                onChange={(event) => setDescription(event.target.value)}
                rows={4}
              />
            </ProjectField>
          </div>

          <DialogFooter className="mx-0 mb-0 rounded-none border-t bg-muted p-5 sm:px-8">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit}
              className="min-w-36 justify-between"
            >
              {submitting ? t('common.creating') : t('common.create')}
              <ArrowRight />
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProjectField({
  id,
  label,
  className,
  children,
}: {
  id: string;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-2 ${className ?? ''}`}>
      <label htmlFor={id} className="editorial-meta text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
