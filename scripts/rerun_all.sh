#!/bin/bash
# Re-run enrichment + pipeline for all leagues with updated code
# Waits for NHL return date fix and MLB audit to complete first
set -e
source /root/.daemon-env
cd /workspace/back-in-play/scripts

echo "=== Waiting for NHL return date fix ==="
while pgrep -f fix_nhl_return_dates > /dev/null 2>&1; do
  sleep 30
  echo "  $(tail -1 /tmp/fix_nhl_returns3.log 2>/dev/null)"
done
echo "NHL fix done: $(tail -1 /tmp/fix_nhl_returns3.log 2>/dev/null)"

echo "=== Waiting for MLB audit ==="
while pgrep -f "pipeline.*mlb" > /dev/null 2>&1; do
  sleep 30
  echo "  $(tail -1 /tmp/audit_mlb.log 2>/dev/null)"
done
echo "MLB audit done"

# Re-enrich all leagues (1-game threshold + prior season fallback)
for league in nba nfl nhl premier-league mlb; do
  echo ""
  echo "=== Enriching $league ==="
  python3 performance_curves_pipeline.py --enrich --league "$league" 2>&1 | tee /tmp/reenrich_${league}.log | tail -5
done

# Re-run pipeline (Phase 4 compute + Phase 5 aggregate)
for league in nba nfl nhl premier-league mlb; do
  echo ""
  echo "=== Pipeline $league ==="
  python3 performance_curves_pipeline.py --pipeline --league "$league" 2>&1 | tee /tmp/repipeline_${league}.log | tail -10
done

echo ""
echo "=== ALL DONE ==="
date
