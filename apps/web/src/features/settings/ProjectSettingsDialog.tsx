import { Hash, Route, Trash2 } from 'lucide-react';
import { useState } from 'react';
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
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast-context';
import type { Project, Settings } from '@/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project | null;
  onDeleted: () => void;
}

export function ProjectSettingsDialog({
  open,
  onOpenChange,
  project,
  onDeleted,
}: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [settings, setSettings] = useState<Settings>(
    project?.settings ?? { spaMode: false, routingType: 'hash' }
  );
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleSave = async () => {
    if (!project) return;
    setSaving(true);
    try {
      await api.updateSettings(project.id, settings);
      toast(t('settings.saved'));
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
          <DialogTitle>
            {t('settings.title')} — {project?.name}
          </DialogTitle>
          <DialogDescription>{t('settings.desc')}</DialogDescription>
        </DialogHeader>

        {project && (
          <div className="space-y-5">
            {/* SPA Mode */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="spa-mode">{t('settings.spaMode')}</Label>
                <p className="text-xs text-muted-foreground">
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
                  <Hash className="size-4 mr-2 shrink-0" />
                  <div className="text-left min-w-0">
                    <p className="text-xs font-medium">
                      {t('settings.routingHash')}
                    </p>
                    <p
                      className={`text-[10px] mt-0.5 whitespace-normal ${settings.routingType === 'hash' ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}
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
                  <Route className="size-4 mr-2 shrink-0" />
                  <div className="text-left min-w-0">
                    <p className="text-xs font-medium">
                      {t('settings.routingPath')}
                    </p>
                    <p
                      className={`text-[10px] mt-0.5 whitespace-normal ${settings.routingType === 'path' ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}
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
                <div className="space-y-0.5 min-w-0">
                  <p className="text-sm font-medium">
                    {t('settings.deleteProject')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('settings.deleteProjectDesc')}
                  </p>
                </div>
                {!confirmDelete ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    className="shrink-0"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 className="size-3.5" />
                    {t('common.delete')}
                  </Button>
                ) : (
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmDelete(false)}
                    >
                      {t('common.close')}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
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
