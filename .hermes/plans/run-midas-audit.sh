#!/bin/bash
# Phase 1: Midas read-only frontend audit (standards-grounded)
cd /home/santhosh/projects/ScamGaurd
opencode run --agent midas "$(cat .hermes/plans/2026-08-13-midas-audit-prompt.md)" > /tmp/scamguard-midas-audit.log 2>&1
echo "EXIT_CODE=$?"
