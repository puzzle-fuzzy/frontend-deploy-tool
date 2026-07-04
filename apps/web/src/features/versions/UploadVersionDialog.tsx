import { type ChangeEvent, type FormEvent, useState } from 'react';
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

interface UploadVersionDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded: () => void;
}

export function UploadVersionDialog({
  projectId,
  open,
  onOpenChange,
  onUploaded,
}: UploadVersionDialogProps) {
  const { t } = useTranslation();
  const api = useApiClient();
  const [description, setDescription] = useState('');
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [folderFiles, setFolderFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = !submitting && (zipFile || folderFiles.length > 0);

  const reset = () => {
    setDescription('');
    setZipFile(null);
    setFolderFiles([]);
    setProgress(0);
    setError(null);
  };

  const handleZipChange = (event: ChangeEvent<HTMLInputElement>) => {
    setZipFile(event.target.files?.[0] ?? null);
    if (event.target.files?.[0]) setFolderFiles([]);
  };

  const handleFolderChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    setFolderFiles(files);
    if (files.length > 0) setZipFile(null);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await api.uploadVersion(
        projectId,
        zipFile,
        folderFiles.length > 0 ? folderFiles : null,
        description,
        setProgress
      );
      reset();
      onUploaded();
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
          <DialogTitle>{t('versions.upload')}</DialogTitle>
          <DialogDescription>{t('versions.uploadDesc')}</DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('versions.description')}
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t('versions.descriptionPlaceholder')}
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('versions.zipArtifact')}
            <Input type="file" accept=".zip" onChange={handleZipChange} />
          </label>

          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('versions.buildFolder')}
            <Input
              type="file"
              multiple
              // React does not type browser-specific folder upload attributes.
              {...{ webkitdirectory: '' }}
              onChange={handleFolderChange}
            />
          </label>

          {submitting && (
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}

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
              {submitting ? t('versions.uploading') : t('versions.upload')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
