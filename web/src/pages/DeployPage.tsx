import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "../../node_modules/react-i18next";
import {
  Plus,
  Settings,
  Globe,
  FolderOpen,
  ChevronRight,
  ExternalLink,
  Copy,
  Sun,
  Moon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { formatDate } from "@/lib/format";
import { CreateProjectDialog } from "./CreateProjectDialog";
import { UploadDialog } from "./UploadDialog";
import { SettingsDialog } from "./SettingsDialog";
import type { Project } from "@/types";

function getHashProjectId(): string {
  const hash = window.location.hash;
  if (hash.startsWith("#/projects/")) return hash.slice("#/projects/".length);
  return "";
}

function setHashProjectId(id: string | null) {
  if (id) {
    window.location.hash = `#/projects/${id}`;
  } else {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}

export function DeployPage() {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [dark, setDark] = useState(() => localStorage.getItem("theme") === "dark");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  const selectProject = useCallback((p: Project | null) => {
    setSelectedProject(p);
    setHashProjectId(p?.id ?? null);
  }, []);

  const fetchProjects = useCallback(async () => {
    try {
      const data = await api.listProjects();
      setProjects(data);
      setSelectedProject((prev) => {
        if (!prev) return prev;
        const updated = data.find((p) => p.id === prev.id);
        return updated ?? null;
      });
    } catch {
      toast(t("common.failed"), "error");
    } finally {
      setLoading(false);
    }
  }, [toast, t]);

  useEffect(() => {
    api.listProjects()
      .then((data) => {
        setProjects(data);
        const hashId = getHashProjectId();
        if (hashId) {
          const found = data.find((p) => p.id === hashId);
          if (found) setSelectedProject(found);
        }
        setLoading(false);
      })
      .catch(() => { setLoading(false); });
  }, []);

  useEffect(() => {
    const handler = () => {
      const hashId = getHashProjectId();
      setSelectedProject((prev) => {
        if (prev?.id === hashId) return prev;
        return null;
      });
      if (hashId) {
        setProjects((current) => {
          const found = current.find((p) => p.id === hashId);
          if (found) setSelectedProject(found);
          return current;
        });
      }
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const handleActivate = async (versionId: string) => {
    if (!selectedProject) return;
    try {
      await api.activateVersion(selectedProject.id, versionId);
      toast(t("common.activated"));
      fetchProjects();
    } catch (err) {
      toast(err instanceof Error ? err.message : t("common.failed"), "error");
    }
  };

  const handleDeleteVersion = async (versionId: string) => {
    if (!selectedProject) return;
    try {
      await api.deleteVersion(selectedProject.id, versionId);
      toast(t("common.deleted"));
      fetchProjects();
    } catch (err) {
      toast(err instanceof Error ? err.message : t("common.failed"), "error");
    }
  };

  const handleDeleteProject = async () => {
    selectProject(null);
    fetchProjects();
  };

  const deployUrl = selectedProject
    ? `${window.location.protocol}//${window.location.hostname}:3000/deploy/${selectedProject.slug}/`
    : "";

  return (
    <div className="flex items-center justify-center min-h-dvh p-6">
      <div className="w-300 h-[80dvh] bg-card rounded-2xl border border-border shadow-sm flex flex-col overflow-hidden">
        {/* Top bar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <FolderOpen className="size-5 text-primary" />
            <h1 className="text-base font-semibold">{t("app.title")}</h1>
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={() => setDark((d) => !d)}>
                  {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{dark ? "Light Mode" : "Dark Mode"}</TooltipContent>
            </Tooltip>
            <Separator orientation="vertical" className="h-5 mx-1" />
            <Button variant="ghost" size="sm" onClick={() => { const next = i18n.language.startsWith("zh") ? "en" : "zh"; i18n.changeLanguage(next); }}>
              <Globe className="size-4" />
              <span className="ml-1 text-xs">{i18n.language.startsWith("zh") ? "EN" : "中"}</span>
            </Button>
          </div>
        </div>

        {/* Two-column body */}
        <div className="flex flex-1 min-h-0">
          {/* Left: Project list */}
          <div className="w-85 border-r border-border flex flex-col">
            <div className="flex items-center justify-between px-4 py-2.5">
              <p className="text-xs font-medium text-muted-foreground">{t("projects.title")}</p>
              <Button variant="ghost" size="icon-xs" onClick={() => setShowCreate(true)}>
                <Plus className="size-3.5" />
              </Button>
            </div>
            <ScrollArea className="flex-1">
              {loading ? (
                <div className="px-4 py-8 text-sm text-muted-foreground text-center">{t("common.loading")}</div>
              ) : projects.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-sm text-muted-foreground">{t("projects.empty")}</p>
                  <p className="text-xs text-muted-foreground mt-1">{t("projects.emptyDesc")}</p>
                </div>
              ) : (
                <div className="px-2 space-y-0.5">
                  {projects.map((project) => (
                    <div
                      key={project.id}
                      className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                        selectedProject?.id === project.id
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-muted/50"
                      }`}
                      onClick={() => selectProject(project)}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{project.name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {project.slug} · {t("projects.versions", { count: project.versions.length })}
                        </p>
                      </div>
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={(e) => { e.stopPropagation(); selectProject(project); setShowSettings(true); }}
                            >
                              <Settings className="size-3" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{t("app.settings")}</TooltipContent>
                        </Tooltip>
                      </div>
                      <ChevronRight className="size-4 text-muted-foreground/50 shrink-0" />
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>

          {/* Right: Version panel */}
          <div className="flex-1 flex flex-col min-w-0">
            {selectedProject ? (
              <>
                {/* Project header */}
                <div className="px-5 py-3 border-b border-border">
                  <div className="flex items-center gap-4">
                    <div className="shrink-0">
                      <h2 className="text-base font-semibold">{selectedProject.name}</h2>
                      <p className="text-xs text-muted-foreground font-mono">{selectedProject.slug}</p>
                    </div>
                    <div className="flex-1 flex items-center justify-end gap-1.5 min-w-0">
                      <a
                        href={deployUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary hover:underline bg-muted px-2 py-1 rounded-md truncate shrink"
                      >
                        {deployUrl}
                      </a>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon-xs"
                            onClick={() => { navigator.clipboard.writeText(deployUrl); toast(t("common.copied")); }}
                          >
                            <Copy className="size-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("common.copy")}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="outline" size="icon-xs" asChild>
                            <a href={deployUrl} target="_blank" rel="noopener noreferrer">
                              <ExternalLink className="size-3" />
                            </a>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("versions.preview")}</TooltipContent>
                      </Tooltip>
                      <Button size="sm" onClick={() => setShowUpload(true)}>
                        <Plus className="size-3.5" />
                        {t("versions.upload")}
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Version list */}
                <ScrollArea className="flex-1">
                  {selectedProject.versions.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16">
                      <FolderOpen className="size-10 text-muted-foreground/30 mb-3" />
                      <p className="text-sm text-muted-foreground">{t("versions.empty")}</p>
                      <p className="text-xs text-muted-foreground mt-1">{t("versions.emptyDesc")}</p>
                    </div>
                  ) : (
                    <div className="p-4 space-y-2">
                      {selectedProject.versions.map((v) => (
                        <div
                          key={v.id}
                          className="flex items-center justify-between p-3 rounded-lg border border-border bg-card hover:bg-muted/30 transition-colors"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <code className="text-xs font-mono">{v.name}</code>
                              {v.active && (
                                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                                  {t("versions.production")}
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {formatDate(v.createdAt)}
                              {v.description && ` · ${v.description}`}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 ml-3">
                            {!v.active && (
                              <Button variant="outline" size="xs" onClick={() => handleActivate(v.id)}>
                                {t("versions.setProduction")}
                              </Button>
                            )}
                            <Button variant="ghost" size="xs" asChild>
                              <a href={`${window.location.protocol}//${window.location.hostname}:3000/deploy/${selectedProject.slug}/${v.id}/`} target="_blank" rel="noopener noreferrer">
                                {t("versions.preview")}
                              </a>
                            </Button>
                            <Button variant="ghost" size="xs" className="text-destructive hover:text-destructive" onClick={() => handleDeleteVersion(v.id)}>
                              {t("common.delete")}
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center">
                <FolderOpen className="size-12 text-muted-foreground/20 mb-3" />
                <p className="text-sm text-muted-foreground">{t("projects.empty")}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Dialogs */}
      <CreateProjectDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={() => { fetchProjects(); }}
      />
      <UploadDialog
        open={showUpload}
        onOpenChange={setShowUpload}
        projectId={selectedProject?.id ?? ""}
        onUploaded={() => { fetchProjects(); }}
      />
      <SettingsDialog
        open={showSettings}
        onOpenChange={setShowSettings}
        project={selectedProject}
        onDeleted={handleDeleteProject}
      />
    </div>
  );
}
