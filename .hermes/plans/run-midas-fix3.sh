#!/bin/bash
# Phase 3d: badge copy micro-fix
cd /home/santhosh/projects/ScamGaurd
opencode run -c --agent midas "$(cat .hermes/plans/2026-08-13-fix3-prompt.md)" > /tmp/scamguard-midas-fix3.log 2>&1
echo "EXIT_CODE=$?"
