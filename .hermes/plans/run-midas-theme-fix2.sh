#!/bin/bash
cd /home/santhosh/projects/ScamGaurd
opencode run -c --agent midas "$(cat .hermes/plans/2026-08-13-theme-fix2-prompt.md)" > /tmp/scamguard-midas-theme-fix2.log 2>&1
echo "EXIT_CODE=$?"
