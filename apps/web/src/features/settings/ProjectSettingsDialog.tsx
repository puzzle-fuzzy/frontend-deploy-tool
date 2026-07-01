import { Hash, Route, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeProjectSlugInput } from '@/features/projects/slug';
import { api } from '@/shared/api';
import type { Project, Settings } from '@/shared/types';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Separator } from '@/shared/ui/separator';
import { Switch } from '@/shared/ui/switch';
import { Textarea } from '@/shared/ui/textarea';
import { useToast } from '@/shared/ui/toast-context';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project | null;
  onDeleted: () => void;
  onSaved: () => void;
}

export function ProjectSettingsDialog({
  open,
  onOpenChange,
  project,
  onDeleted,
  onSaved,
}: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [settings, setSettings] = useState<Settings>(
    project?.settings ?? { spaMode: false, routingType: 'hash' }
  );
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Project info editing
  const [name, setName] = useState(project?.name ?? '');
  const [slug, setSlug] = useState(project?.slug ?? '');
  const [description, setDescription] = useState(project?.description ?? '');

  // Reset form when project changes
  useEffect(() => {
    if (project) {
      setName(project.name);
      setSlug(project.slug);
      setDescription(project.description || '');
      setSettings(project.settings);
    }
    setConfirmDelete(false);
  }, [project]);

  useEffect(() => {
    if (!open) setConfirmDelete(false);
  }, [open]);

  const handleSave = async () => {
    if (!project) return;
    setSaving(true);
    try {
      // Update project info
      await api.updateProject(project.id, {
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim(),
      });
      // Update settings
      await api.updateSettings(project.id, settings);
      toast(t('settings.saved'));
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : t('common.failed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!project) return;
    try {
      await api.deleteProject(project.id);
      toast(t('common.deleted'));
      onOpenChange(false);
      onDeleted();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('common.failed'), 'error');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('settings.title')}</DialogTitle>
          <DialogDescription>{t('settings.desc')}</DialogDescription>
        </DialogHeader>

        {project && (
          <div className="space-y-5">
            {/* Project info */}
            <div className="space-y-3">
              <Label className="text-base font-medium">
                {t('settings.projectInfo')}
              </Label>
              <div className="space-y-2">
                <div>
                  <Label htmlFor="project-name" className="text-sm">
                    {t('create.name')}
                  </Label>
                  <Input
                    id="project-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('create.namePlaceholder')}
                  />
                </div>
                <div>
                  <Label htmlFor="project-slug" className="text-sm">
                    {t('create.slug')}
                  </Label>
                  <Input
                    id="project-slug"
                    value={slug}
                    onChange={(e) =>
                      setSlug(normalizeProjectSlugInput(e.target.value))
                    }
                    placeholder={t('create.slugPlaceholder')}
                    className="font-mono"
                  />
                </div>
                <div>
                  <Label htmlFor="project-desc" className="text-sm">
                    {t('create.description')}
                  </Label>
                  <Textarea
                    id="project-desc"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t('create.descPlaceholder')}
                    rows={2}
                  />
                </div>
              </div>
            </div>

            <Separator />
            {/* SPA Mode */}
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label htmlFor="spa-mode" className="text-sm">
                  {t('settings.spaMode')}
                </Label>
                <p className="text-sm text-muted-foreground">
                  {t('settings.spaModeDesc')}
                </p>
              </div>
              <Switch
                id="spa-mode"
                checked={settings.spaMode}
                onCheckedChange={(checked) =>
                  setSettings((s) => ({ ...s, spaMode: checked }))
                }
              />
            </div>

            <Separator />

            {/* Routing type */}
            <div className="space-y-3">
              <Label>{t('settings.routingType')}</Label>
              <div className="space-y-2">
                <Button
                  type="button"
                  variant={
                    settings.routingType === 'hash' ? 'default' : 'outline'
                  }
                  className="w-full h-auto py-2.5 justify-start"
                  onClick={() =>
                    setSettings((s) => ({ ...s, routingType: 'hash' }))
                  }
                >
                  <Hash className="size-5 mr-2 shrink-0" />
                  <div className="text-left min-w-0">
                    <p className="text-sm font-medium">
                      {t('settings.routingHash')}
                    </p>
                    <p
                      className={`text-xs mt-0.5 whitespace-normal ${settings.routingType === 'hash' ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}
                    >
                      {t('settings.routingHashDesc')}
                    </p>
                  </div>
                </Button>
                <Button
                  type="button"
                  variant={
                    settings.routingType === 'path' ? 'default' : 'outline'
                  }
                  className="w-full h-auto py-2.5 justify-start"
                  onClick={() =>
                    setSettings((s) => ({ ...s, routingType: 'path' }))
                  }
                >
                  <Route className="size-5 mr-2 shrink-0" />
                  <div className="text-left min-w-0">
                    <p className="text-sm font-medium">
                      {t('settings.routingPath')}
                    </p>
                    <p
                      className={`text-xs mt-0.5 whitespace-normal ${settings.routingType === 'path' ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}
                    >
                      {t('settings.routingPathDesc')}
                    </p>
                  </div>
                </Button>
              </div>
            </div>

            <Separator />

            {/* Danger zone */}
            <div className="space-y-2">
              <Label className="text-destructive">
                {t('settings.dangerZone')}
              </Label>
              <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-destructive/20">
                <div className="space-y-1 min-w-0">
                  <p className="text-base font-medium">
                    {t('settings.deleteProject')}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.deleteProjectDesc')}
                  </p>
                </div>
                {!confirmDelete ? (
                  <Button
                    variant="destructive"
                    size="default"
                    className="shrink-0"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 className="size-4" />
                    {t('common.delete')}
                  </Button>
                ) : (
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="outline"
                      size="default"
                      onClick={() => setConfirmDelete(false)}
                    >
                      {t('common.close')}
                    </Button>
                    <Button
                      variant="destructive"
                      size="default"
                      onClick={handleDelete}
                    >
                      {t('common.confirm')}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
          <Button onClick={handleSave} disabled={saving || !project}>
            {t('settings.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
