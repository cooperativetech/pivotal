#!/bin/bash

# Run the flack-based evaluation with LLM personas

echo "Starting Flack-based evaluation with LLM personas..."
echo ""

# Load environment variables from .env file (now two levels up)
if [ -f ../../.env ]; then
    export $(grep -v '^#' ../../.env | xargs)
fi

# Make sure we have the required environment variable
if [ -z "$OPENROUTER_API_KEY" ] && [ -z "$PV_OPENROUTER_API_KEY" ]; then
    echo "Error: OPENROUTER_API_KEY or PV_OPENROUTER_API_KEY environment variable is not set"
    exit 1
fi

# Use PV_OPENROUTER_API_KEY if OPENROUTER_API_KEY is not set
if [ -z "$OPENROUTER_API_KEY" ]; then
    export OPENROUTER_API_KEY="$PV_OPENROUTER_API_KEY"
fi

# Run with 2-case benchmark for testing (use benchmark-data-100-cases.json for full eval)
npx tsx flack-eval.ts benchmark-data-2-cases.json 1.0 google/gemini-2.5-flash

echo ""
echo "Evaluation complete!"