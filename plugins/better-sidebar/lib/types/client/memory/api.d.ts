/**
 * Memory console API client — talks to the hpptools-memory plugin's
 * loopback routes (`/hpptools-memory/api/*`, same origin). The memory
 * backend (config / stats / files / models / runs / migration) lives in
 * that plugin; this panel is a pure consumer.
 */
/** One overview response (shape mirrors webui.js overviewData). */
export interface MemoryOverview {
    root: string;
    migrated: {
        from: string;
        copiedItems: number;
        at: string;
    } | null;
    /** Legacy Pi memory path when detected and not yet migrated. */
    legacy: string | null;
    core: boolean;
    rules: boolean;
    notebook: boolean;
    projects: {
        name: string;
        current: boolean;
        files: number;
        entries: number;
        skillFiles: number;
    }[];
    projectSummary: {
        count: number;
        files: number;
        entries: number;
        skillFiles: number;
    } | null;
    currentProject: string | null;
    globalMem: {
        files: number;
        entries: number;
        skillFiles: number;
    };
    lastMaintenance: {
        lastRun: string;
        project?: string;
    } | null;
    activeRuns: number;
    configured: {
        extractor: string;
        cleaner: string;
    };
}
/** One provider + its models (modelsData). */
export interface MemoryModelProvider {
    id: string;
    name: string;
    models: {
        id: string;
        name?: string;
    }[];
}
/** One subagent run row (runs.js shape). */
export interface MemoryRun {
    id: string;
    kind: string;
    status: string;
    startedAt: string;
    endedAt: string | null;
    stopReason: string | null;
    log?: string[];
}
/** The file tree response (filesData). */
export interface MemoryFileGroup {
    id: string;
    label: string;
    files: {
        rel: string;
        name: string;
        entries: number;
    }[];
}
export interface MemoryFiles {
    currentProject: string | null;
    groups: MemoryFileGroup[];
}
/** The /file GET response. */
export interface MemoryFileContent {
    path: string;
    content: string;
}
/** The memory console API surface (plugin-global; no session scope). */
export declare const memoryApi: {
    overview: (signal?: AbortSignal) => Promise<MemoryOverview>;
    models: (signal?: AbortSignal) => Promise<{
        configured: {
            extractor: string;
            cleaner: string;
        };
        providers: MemoryModelProvider[];
    }>;
    runs: (signal?: AbortSignal) => Promise<{
        runs: MemoryRun[];
    }>;
    files: (signal?: AbortSignal) => Promise<MemoryFiles>;
    file: (path: string, signal?: AbortSignal) => Promise<MemoryFileContent>;
    saveFile: (path: string, content: string) => Promise<{
        ok: true;
    }>;
    setModel: (kind: "extractor" | "cleaner", value: string) => Promise<{
        value: string;
    }>;
    clean: () => Promise<{
        ok: true;
        runId: string;
    }>;
    migrate: () => Promise<{
        copiedItems: number;
        from: string;
    }>;
    saveRoot: (root: string, copyData: boolean) => Promise<{
        saved: boolean;
        root: string;
        copied: number;
        restart: boolean;
    }>;
    openFolder: (rel: string) => Promise<{
        ok: true;
    }>;
};
/** Format an ISO time with the active locale. */
export declare function formatTime(iso: string | null | undefined, isZh: boolean): string;
/** Format a duration between two ISO timestamps. */
export declare function formatDur(startIso: string, endIso: string | null): string;
