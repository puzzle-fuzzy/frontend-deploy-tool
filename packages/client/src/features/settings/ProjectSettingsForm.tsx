import { ArrowRight, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApiClient } from '@/api/ApiClientProvider';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast-context';
import { getLocalizedError } from '@/shared/error-messages';
import type { Project } from '@/shared/types';
import { normalizeProjectSlugInput } from '../projects/slug';

interface ProjectSettingsFormProps {
  project: Project;
  canManage: boolean;
  onSaved: () => void;
  onDeleted: () => void;
}

export function ProjectSettingsForm({
  project,
  canManage,
  onSaved,
  onDeleted,
}: ProjectSettingsFormProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const api = useApiClient();
  const [name, setName] = useState(project.name);
  const [slug, setSlug] = useState(project.slug);
  const [description, setDescription] = useState(project.description);
  const [spaMode, setSpaMode] = useState(project.settings.spaMode);
  const [routingType, setRoutingType] = useState(project.settings.routingType);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);

    try {
      await api.updateProject(project.id, {
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim(),
      });
      await api.updateSettings(project.id, { spaMode, routingType });
      toast(t('settings.saved'));
      onSaved();
    } catch (err) {
      toast(getLocalizedError(err, t, t('common.failed')), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteProject(project.id);
      setDeleteDialogOpen(false);
      onDeleted();
    } catch (err) {
      toast(getLocalizedError(err, t, t('common.failed')), 'error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <form className="flex flex-col gap-10" onSubmit={handleSubmit}>
      <section>
        <div className="mb-5 flex items-center justify-between border-b pb-4">
          <span className="editorial-meta text-primary">
            A / {t('settings.projectInfo')}
          </span>
          <span className="editorial-meta text-muted-foreground">Metadata</span>
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <SettingsField id="settings-name" label={t('create.name')}>
            <Input
              id="settings-name"
              value={name}
              placeholder={t('create.namePlaceholder')}
              onChange={(event) => setName(event.target.value)}
              disabled={!canManage}
              className="h-12"
              required
            />
          </SettingsField>
          <SettingsField id="settings-slug" label={t('create.slug')}>
            <Input
              id="settings-slug"
              value={slug}
              placeholder={t('create.slugPlaceholder')}
              onChange={(event) =>
                setSlug(normalizeProjectSlugInput(event.target.value))
              }
              disabled={!canManage}
              className="h-12 font-mono text-sm"
              required
            />
          </SettingsField>
          <SettingsField
            id="settings-description"
            label={t('create.description')}
            className="md:col-span-2"
          >
            <Textarea
              id="settings-description"
              value={description}
              rows={4}
              className="field-sizing-fixed"
              placeholder={t('create.descPlaceholder')}
              onChange={(event) => setDescription(event.target.value)}
              disabled={!canManage}
            />
          </SettingsField>
        </div>
      </section>

      <section>
        <div className="mb-5 flex items-center justify-between border-b pb-4">
          <span className="editorial-meta text-primary">
            B / Deployment behavior
          </span>
          <span className="editorial-meta text-muted-foreground">Routing</span>
        </div>
        <div className="grid gap-px bg-border md:grid-cols-2">
          <label
            htmlFor="settings-spa-mode"
            className="flex min-h-40 cursor-pointer flex-col justify-between bg-card p-6"
          >
            <span className="flex items-start justify-between gap-5">
              <span>
                <span className="editorial-number text-5xl text-primary">
                  01
                </span>
                <span className="mt-6 block text-lg font-medium">
                  {t('settings.spaMode')}
                </span>
              </span>
              <Checkbox
                id="settings-spa-mode"
                checked={spaMode}
                onCheckedChange={(checked) => setSpaMode(checked === true)}
                disabled={!canManage}
              />
            </span>
            <span className="editorial-meta text-muted-foreground">
              index.html fallback
            </span>
          </label>

          <div className="flex min-h-40 flex-col justify-between bg-card p-6">
            <div>
              <span className="editorial-number text-5xl text-primary">02</span>
              <p className="mt-6 text-lg font-medium">
                {t('settings.routingType')}
              </p>
            </div>
            <Select
              value={routingType}
              onValueChange={(value) =>
                setRoutingType(value === 'path' ? 'path' : 'hash')
              }
              disabled={!canManage}
            >
              <SelectTrigger className="mt-5 h-11 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="hash">
                    {t('settings.routingHash')}
                  </SelectItem>
                  <SelectItem value="path">
                    {t('settings.routingPath')}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>
      </section>

      <div className="flex justify-end border-t pt-5">
        <Button
          type="submit"
          disabled={!canManage || submitting}
          className="min-w-44 justify-between"
        >
          {submitting ? t('common.saving') : t('common.save')}
          <ArrowRight />
        </Button>
      </div>

      <section className="grid border border-destructive/40 md:grid-cols-[1fr_auto]">
        <div className="p-5 md:p-6">
          <span className="editorial-meta text-destructive">
            C / {t('settings.dangerZone')}
          </span>
          <p className="mt-3 text-sm text-muted-foreground">
            {t('settings.deleteProjectDesc')}
          </p>
        </div>
        <div className="flex items-center border-t p-5 md:border-l md:border-t-0">
          <Button
            type="button"
            variant="destructive"
            disabled={!canManage || deleting}
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 />
            {deleting ? t('common.deleting') : t('settings.deleteProject')}
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={t('settings.deleteProject')}
        description={t('settings.deleteProjectConfirm', {
          name: project.name,
        })}
        confirmLabel={
          deleting ? t('common.deleting') : t('settings.deleteProject')
        }
        cancelLabel={t('common.cancel')}
        onConfirm={handleDelete}
        loading={deleting}
        destructive
      />
    </form>
  );
}

function SettingsField({
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
