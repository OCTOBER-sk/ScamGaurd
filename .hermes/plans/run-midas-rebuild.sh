#!/bin/bash
# Phase 3: fresh Midas session — full frontend rebuild per spec
cd /home/santhosh/projects/ScamGaurd
opencode run --agent midas "$(cat .hermes/plans/2026-08-13-rebuild-prompt.md)" \
  -f .hermes/plans/2026-08-13-rebuild-spec.md \
  -f FRONTEND-AUDIT-2026-08-13.md \
  -f PLAN-FRONTEND.md > /tmp/scamguard-midas-rebuild.log 2>&1
echo "EXIT_CODE=$?"
