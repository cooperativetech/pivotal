#!/bin/bash

# Run the flack-based evaluation with LLM personas

echo "Starting Flack-based evaluation with LLM personas..."
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

# Change to the evals directory and run with 2-case benchmark for testing
cd "$SCRIPT_DIR"
npx tsx flack-eval.ts benchmark-data-2-cases.json 1.0 google/gemini-2.5-flash

echo ""
echo "Evaluation complete!"
