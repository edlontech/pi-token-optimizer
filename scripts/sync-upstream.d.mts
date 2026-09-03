export function tagCommitRef(tag: string): string;
export function replaceManifest(manifest: string, bytes: Uint8Array): Promise<void>;
export function syncUpstream(source: string): Promise<{ files: number; changedFiles: number }>;
