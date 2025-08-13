#!/bin/bash

# Script to run evaluation in either persona or calendar mode

MODE=${1:-persona}
BENCHMARK=${2:-benchmark-data-2-cases.json}
CALENDAR_PROB=${3:-1.0}
MODEL=${4:-google/gemini-2.5-flash}

echo "=================================="
echo "Running Evaluation"
echo "=================================="
echo "Mode: $MODE"
echo "Benchmark: $BENCHMARK"
echo "Calendar Probability: $CALENDAR_PROB"
echo "Model: $MODEL"
echo "=================================="

# Load environment variables
export $(grep -v '^#' .env | xargs)

# Run the evaluation
npx tsx src/evals/flack-eval-dual-mode.ts "$MODE" "$BENCHMARK" "$CALENDAR_PROB" "$MODEL"