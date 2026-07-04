import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApiClient } from '@/api/ApiClientProvider';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  const api = useApiClient();
  const [name, setName] = useState(project.name);
  const [slug, setSlug] = useState(project.slug);
  const [description, setDescription] = useState(project.description);
  const [spaMode, setSpaMode] = useState(project.settings.spaMode);
  const [routingType, setRoutingType] = useState(project.settings.routingType);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await api.updateProject(project.id, {
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim(),
      });
      await api.updateSettings(project.id, { spaMode, routingType });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(t('settings.deleteProjectConfirm', { name: project.name }))) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await api.deleteProject(project.id);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.failed'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t('create.name')}
          <Input
            value={name}
            placeholder={t('create.namePlaceholder')}
            onChange={(event) => setName(event.target.value)}
            disabled={!canManage}
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
            disabled={!canManage}
            required
          />
        </label>
      </div>

      <label className="flex flex-col gap-1.5 text-sm font-medium">
        {t('create.description')}
        <Textarea
          value={description}
          rows={4}
          className="field-sizing-fixed"
          placeholder={t('create.descPlaceholder')}
          onChange={(event) => setDescription(event.target.value)}
          disabled={!canManage}
        />
      </label>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox
            checked={spaMode}
            onCheckedChange={(checked) => setSpaMode(checked === true)}
            disabled={!canManage}
          />
          {t('settings.spaMode')}
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t('settings.routingType')}
          <Select
            value={routingType}
            onValueChange={(value) =>
              setRoutingType(value === 'path' ? 'path' : 'hash')
            }
            disabled={!canManage}
          >
            <SelectTrigger className="w-full">
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
        </label>
      </div>

      {error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex justify-between gap-2">
        <Button
          type="button"
          variant="destructive"
          disabled={!canManage || deleting}
          onClick={handleDelete}
        >
          {deleting ? t('common.deleting') : t('settings.deleteProject')}
        </Button>
        <Button type="submit" disabled={!canManage || submitting}>
          {submitting ? t('common.saving') : t('common.save')}
        </Button>
      </div>
    </form>
  );
}
