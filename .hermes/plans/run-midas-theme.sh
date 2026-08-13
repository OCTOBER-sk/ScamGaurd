#!/bin/bash
# Phase 4: theme rebuild — system light/dark + clean professional redesign (fresh Midas)
cd /home/santhosh/projects/ScamGaurd
opencode run --agent midas "$(cat .hermes/plans/2026-08-13-theme-prompt.md)" \
  -f .hermes/plans/2026-08-13-theme-rebuild-spec.md \
  -f FRONTEND-AUDIT-2026-08-13.md > /tmp/scamguard-midas-theme.log 2>&1
echo "EXIT_CODE=$?"
