#!/bin/bash

# Run the flack-based evaluation with configurable mode

# Default values
MODE="${1:-persona}"  # Default to persona mode
BENCHMARK_FILE="${2:-benchmark-data-2-cases.json}"
CALENDAR_PROB="${3:-1.0}"
MODEL="${4:-google/gemini-2.5-flash}"

echo "Starting Flack-based evaluation..."
echo "Mode: $MODE"
echo "Benchmark file: $BENCHMARK_FILE"
echo "Calendar probability: $CALENDAR_PROB"
echo "Model: $MODEL"
echo ""

# Load environment variables from .env file in project root
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$SCRIPT_DIR/../.."
if [ -f "$PROJECT_ROOT/.env" ]; then
    export $(grep -v '^#' "$PROJECT_ROOT/.env" | xargs)
fi

# Make sure we have the required environment variable
if [ -z "$PV_OPENROUTER_API_KEY" ]; then
    echo "Error: PV_OPENROUTER_API_KEY environment variable is not set"
    exit 1
fi

# Change to the evals directory and run the dual-mode evaluation
cd "$SCRIPT_DIR"
npx tsx flack-eval-dual-mode.ts "$MODE" "$BENCHMARK_FILE" "$CALENDAR_PROB" "$MODEL"

echo ""
echo "Evaluation complete!"
