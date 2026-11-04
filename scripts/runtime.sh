#!/usr/bin/env bash
# Shared resource and source-identity policy for check.sh and pack.sh.

# The verification image is the Node version pinned in .nvmrc.
node_check_image() {
  local version
  version=$(<"$1/.nvmrc")
  printf 'node:%s\n' "${version#v}"
}

require_load() {
  local load
  read -r load _ </proc/loadavg
  awk -v value="$load" 'BEGIN { exit !(value < 24) }' || {
    echo 'delivery-kit: one-minute load must be below 24 before starting a container' >&2
    return 1
  }
}

# Digest of Git status plus the name, mode and content of every listed file. A source snapshot
# without Git metadata is identified by its SOURCE_COMMIT and file contents instead.
source_fingerprint() {
  local digest
  digest=$(set -o pipefail; _fingerprint_stream "$1" | sha256sum) || return 1
  printf '%s\n' "${digest%% *}"
}

_list_sources() {
  local root=$1
  if [[ -e $root/.git ]]; then
    git -C "$root" ls-files --cached --others --exclude-standard -z
  else
    (cd -- "$root" && find . \( -type f -o -type l \) -printf '%P\0')
  fi
}

_fingerprint_stream() {
  local root=$1 path names=()
  if [[ -e $root/.git ]]; then
    git -C "$root" rev-parse HEAD || return 1
    git -C "$root" status --porcelain=v1 --untracked-files=all -z || return 1
  elif [[ -f $root/SOURCE_COMMIT ]]; then
    printf 'snapshot\0'
  else
    echo 'delivery-kit: checks require a checkout or identified source snapshot' >&2
    return 1
  fi
  mapfile -d '' names < <(_list_sources "$root" | sort -zu) || return 1
  # Credential-shaped paths are refused before any content is read.
  for path in "${names[@]}"; do
    case "/$path/" in
      */.env/* | */.env.*/* | */.ssh/* | */.private/*)
        echo 'delivery-kit: refusing a credential-shaped path in the source fingerprint' >&2
        return 1
        ;;
    esac
  done
  for path in "${names[@]}"; do
    printf '%s\0' "$path"
    if [[ -L $root/$path ]]; then
      printf 'link:%s\0' "$(readlink -- "$root/$path")"
    elif [[ -f $root/$path ]]; then
      printf '%s\0' "$(stat -c %a -- "$root/$path")"
      sha256sum <"$root/$path" || return 1
    else
      printf 'missing\0'
    fi
  done
}
