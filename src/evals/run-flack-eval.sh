#!/bin/bash

# Run the flack-based evaluation with LLM personas

echo "Starting Flack-based evaluation with LLM personas..."
echo ""

# Load environment variables from .env file (now two levels up)
if [ -f ../../.env ]; then
    export $(grep -v '^#' ../../.env | xargs)
fi

# Make sure we have the required environment variable
if [ -z "$PV_OPENROUTER_API_KEY" ]; then
    echo "Error: PV_OPENROUTER_API_KEY environment variable is not set"
    exit 1
fi

# Run with 2-case benchmark for testing (use benchmark-data-100-cases.json for full eval)
npx tsx flack-eval.ts benchmark-data-2-cases.json 1.0 google/gemini-2.5-flash

echo ""
echo "Evaluation complete!"
