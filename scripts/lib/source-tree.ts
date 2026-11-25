/**
 * The source manifest for the TypeScript scripts of the validation. The
 * manifest itself, with the patterns of the files it covers, is
 * scripts/source-manifest.mjs.
 */
export interface SourceManifest {
  /** Number of hashed files. */
  files: number;
  /** Combined hash, which identifies the tree. */
  sha256: string;
  entries: { path: string; bytes: number; sha256: string }[];
}

const manifestModule = (await import(new URL('../source-manifest.mjs', import.meta.url).href)) as {
  sourceManifest(root?: string): SourceManifest;
};

/** The manifest of the tree that contains the scripts, computed from the files when called. */
export function sourceManifest(): SourceManifest {
  return manifestModule.sourceManifest();
}
