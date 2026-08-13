#!/bin/bash
# Phase 3c: final micro-fix (provider card note copy)
cd /home/santhosh/projects/ScamGaurd
opencode run -c --agent midas "$(cat .hermes/plans/2026-08-13-fix2-prompt.md)" > /tmp/scamguard-midas-fix2.log 2>&1
echo "EXIT_CODE=$?"
