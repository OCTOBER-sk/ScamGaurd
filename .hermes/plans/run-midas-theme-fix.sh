#!/bin/bash
# Theme micro-fix: dark high-risk contrast
cd /home/santhosh/projects/ScamGaurd
opencode run -c --agent midas "$(cat .hermes/plans/2026-08-13-theme-fix-prompt.md)" > /tmp/scamguard-midas-theme-fix.log 2>&1
echo "EXIT_CODE=$?"
