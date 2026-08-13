#!/bin/bash
# Phase 3b: targeted fix round (resume session, hard rules)
cd /home/santhosh/projects/ScamGaurd
opencode run -c --agent midas "$(cat .hermes/plans/2026-08-13-fix-round-prompt.md)" > /tmp/scamguard-midas-fix.log 2>&1
echo "EXIT_CODE=$?"
