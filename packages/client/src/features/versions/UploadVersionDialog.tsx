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
      <DialogContent className="gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="grid gap-0 border-b sm:grid-cols-[10rem_1fr]">
          <div className="border-b bg-primary p-6 text-primary-foreground sm:border-b-0 sm:border-r">
            <span className="editorial-number text-6xl">01</span>
            <HardDriveUpload className="mt-16 size-5" />
          </div>
          <div className="p-6 sm:p-8">
            <span className="editorial-meta text-primary">
              Artifact / Upload
            </span>
            <DialogTitle className="mt-5 text-3xl font-normal tracking-[-0.05em]">
              {t('upload.title')}
            </DialogTitle>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {t('versions.uploadDesc')}
            </p>
          </div>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <FieldGroup className="gap-5 p-6 sm:p-8">
            <button
              type="button"
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={handleSelectZip}
              className="group grid min-h-56 w-full cursor-pointer border bg-card text-left hover:border-primary hover:bg-primary hover:text-primary-foreground sm:grid-cols-[10rem_1fr]"
            >
              <div className="flex items-start justify-between border-b p-6 sm:block sm:border-b-0 sm:border-r">
                <span className="editorial-number text-6xl text-primary group-hover:text-primary-foreground">
                  01
                </span>
                <Upload className="size-6 text-primary group-hover:text-primary-foreground sm:mt-16" />
              </div>
              <div className="flex flex-col justify-end p-6 sm:p-8">
                <p className="text-2xl font-medium tracking-[-0.04em] sm:text-3xl">
                  {label ?? t('upload.dropzone')}
                </p>
                <p className="mt-3 text-sm text-muted-foreground group-hover:text-primary-foreground/70">
                  {t('upload.dropzoneDesc')}
                </p>
                <span className="editorial-meta mt-8 border-t pt-4 text-muted-foreground group-hover:border-primary-foreground/25 group-hover:text-primary-foreground/70">
                  ZIP / Directory / index.html
                </span>
              </div>
            </button>

            <div className="grid gap-2 sm:grid-cols-3">
              <Button
                variant="outline"
                size="default"
                type="button"
                onClick={handleSelectZip}
                className="h-12 justify-between px-4"
              >
                <FileArchive className="size-4" />
                {t('upload.selectZip')}
              </Button>
              <Button
                variant="outline"
                size="default"
                type="button"
                onClick={handleSelectFolder}
                className="h-12 justify-between px-4"
              >
                <FolderOpen className="size-4" />
                {t('upload.selectFolder')}
              </Button>
              {native && (
                <Button
                  variant="outline"
                  size="default"
                  type="button"
                  className="h-12 justify-between px-4"
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
              <div className="grid items-center gap-4 border bg-muted p-4 sm:grid-cols-[1fr_auto]">
                <Progress value={progress} className="h-2" />
                <p className="editorial-meta text-right text-primary">
                  {String(progress).padStart(3, '0')}%
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

            <DialogFooter className="mx-0 -mb-8 rounded-none border-t bg-muted p-5 sm:-mx-8 sm:px-8">
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
                className="min-w-40"
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
