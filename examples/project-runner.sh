#!/usr/bin/env bash
# Copy this adapter beside the project's trusted delivery configuration.
set -euo pipefail
PROJECT=$(cd "$(dirname "$0")" && pwd)
# Set these two literal values when adopting an approved exported source snapshot.
# Adopt configuration/reporting changes at an idle single-runner boundary.
# This adapter does not reload resident processes or retarget detached reporters.
TOOL=/absolute/path/to/pinned-snapshot
REVISION=REPLACE_WITH_REVIEWED_COMMIT
exec "$TOOL/bin/delivery-kit" \
  --config "$PROJECT/bus.conf" \
  --state-dir "$PROJECT" \
  --revision "$REVISION" run
