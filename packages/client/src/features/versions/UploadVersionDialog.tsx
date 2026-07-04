import { useApiClient, useNative } from '@deploykit/client';
import { FileArchive, FolderOpen, HardDriveUpload, Upload } from 'lucide-react';
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
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast-context';
import { getLocalizedError } from '../../shared/error-messages';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onUploaded: () => void;
}

export function UploadVersionDialog({
  open,
  onOpenChange,
  projectId,
  onUploaded,
}: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const api = useApiClient();
  const native = useNative();
  const releaseNotesId = 'upload-release-notes';
  const [file, setFile] = useState<File | null>(null);
  const [folderFiles, setFolderFiles] = useState<File[] | null>(null);
  // Native-picked directory: absolute disk path + its NativeFile entries.
  const [nativeDir, setNativeDir] = useState<{
    path: string;
    files: File[];
  } | null>(null);
  const [desc, setDesc] = useState('');
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (open) return;
    setFile(null);
    setFolderFiles(null);
    setNativeDir(null);
    setDesc('');
    setProgress(0);
  }, [open]);

  const label = file
    ? file.name
    : nativeDir
      ? t('upload.selectedFiles', { count: nativeDir.files.length })
      : folderFiles
        ? t('upload.selectedFiles', { count: folderFiles.length })
        : null;

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) {
      setFile(f);
      setFolderFiles(null);
      setNativeDir(null);
    }
  };

  const handleSelectZip = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip';
    input.onchange = () => {
      if (input.files?.[0]) {
        setFile(input.files[0]);
        setFolderFiles(null);
        setNativeDir(null);
      }
    };
    input.click();
  };

  const handleSelectFolder = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.onchange = () => {
      if (input.files && input.files.length > 0) {
        setFolderFiles(Array.from(input.files));
        setFile(null);
        setNativeDir(null);
      }
    };
    input.click();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!file && !folderFiles && !nativeDir) || !projectId) return;
    setUploading(true);
    try {
      if (native && nativeDir) {
        // Desktop path: the main process reads bytes from disk and reports
        // progress over IPC. nativeDir holds the absolute directory path.
        await native.uploadFolder(projectId, nativeDir.path, desc, setProgress);
      } else {
        // Web path: XHR upload of the picked File objects.
        await api.uploadVersion(
          projectId,
          file,
          folderFiles,
          desc,
          setProgress
        );
      }
      toast(t('common.uploaded'));
      native?.showNotification('DeployKit', t('common.uploaded'));
      setFile(null);
      setFolderFiles(null);
      setNativeDir(null);
      setDesc('');
      setProgress(0);
      onUploaded();
      onOpenChange(false);
    } catch (err) {
      toast(getLocalizedError(err, t, t('common.failed')), 'error');
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-md border border-primary/35 bg-primary/12 text-primary">
              <HardDriveUpload className="size-4" />
            </span>
            {t('upload.title')}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <button
              type="button"
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={handleSelectZip}
              className="flex w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-primary/45 bg-primary/6 p-8 text-center transition-colors hover:bg-primary/10"
            >
              <div className="mb-3 flex size-12 items-center justify-center rounded-lg border border-primary/35 bg-card text-primary">
                <Upload className="size-6" />
              </div>
              <p className="text-base font-medium">
                {label ?? t('upload.dropzone')}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('upload.dropzoneDesc')}
              </p>
            </button>

            <div className="grid gap-2 sm:grid-cols-3">
              <Button
                variant="outline"
                size="default"
                type="button"
                onClick={handleSelectZip}
              >
                <FileArchive className="size-4" />
                {t('upload.selectZip')}
              </Button>
              <Button
                variant="outline"
                size="default"
                type="button"
                onClick={handleSelectFolder}
              >
                <FolderOpen className="size-4" />
                {t('upload.selectFolder')}
              </Button>
              {native && (
                <Button
                  variant="outline"
                  size="default"
                  type="button"
                  onClick={async () => {
                    const picked = await native.pickDirectory();
                    if (picked) {
                      // NativeFile is structurally compatible with File.
                      setNativeDir({
                        path: picked.directoryPath,
                        files: picked.files as unknown as File[],
                      });
                      setFile(null);
                      setFolderFiles(null);
                    }
                  }}
                >
                  <FolderOpen className="size-4" />
                  Pick directory
                </Button>
              )}
            </div>

            {uploading && (
              <div className="space-y-1 rounded-lg border border-border bg-muted/35 p-3">
                <Progress value={progress} className="h-1.5" />
                <p className="text-right text-xs text-muted-foreground">
                  {progress}%
                </p>
              </div>
            )}

            <Field>
              <FieldLabel htmlFor={releaseNotesId}>
                {t('upload.releaseNotes')}
              </FieldLabel>
              <Textarea
                id={releaseNotesId}
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder={t('upload.releaseNotesPlaceholder')}
                rows={3}
              />
            </Field>

            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                size="default"
                onClick={() => onOpenChange(false)}
              >
                {t('upload.cancel')}
              </Button>
              <Button
                type="submit"
                disabled={(!file && !folderFiles && !nativeDir) || uploading}
                size="default"
              >
                {uploading ? `${progress}%` : t('upload.submit')}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
