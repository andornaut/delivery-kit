// Container argument rules shared by the gate and verification containers.
//
// Every container runs as the dedicated uid 19001, which owns nothing on the host, with
// HOME=/tmp. Every host bind mount is read-only, and no container writes to the host:
// outputs, caches and scratch live in the container's own filesystem, tmpfs or named
// volumes, and the host user copies results out with `docker cp`.
//
// A named volume mounted at /var/tmp copies that directory's mode (1777) when the volume is
// first created, so uid 19001 can write the npm cache inside it without a root step.

export const CONTAINER_USER = "19001:19001";
export const VOLUME_TARGET = "/var/tmp";
export const NPM_CACHE = `${VOLUME_TARGET}/npm`;

export function userArgs(): string[] {
  return ["--user", CONTAINER_USER, "-e", "HOME=/tmp"];
}

/** A read-only bind mount. There is no writable form. */
export function bindMount(source: string, target: string): string[] {
  if (/[,"]/.test(source) || /[,"]/.test(target)) {
    throw new Error(`bind mount paths must not contain a comma or quote: ${source}`);
  }
  return ["--mount", `type=bind,src=${source},dst=${target},readonly`];
}

/** The per-game named volume holding the gate's npm cache. */
export function npmVolume(game: string): string {
  return `delivery-kit-npm-${game}`;
}

/** Mount a named volume at /var/tmp and point npm's cache inside it. */
export function npmCacheArgs(volume: string): string[] {
  return [
    "--mount",
    `type=volume,src=${volume},dst=${VOLUME_TARGET}`,
    "-e",
    `npm_config_cache=${NPM_CACHE}`,
  ];
}
