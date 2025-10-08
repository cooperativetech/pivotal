# Scheduling Evaluation Framework

This directory contains tools for evaluating AI-assisted scheduling performance through automated benchmark generation and conversation simulation.

## Quick Start

```bash
# Generate benchmark data (creates new folder with timestamp)
pnpm run gen-benchmark

# Add more benchmarks to an existing generation batch
pnpm run gen-benchmark --genTimestamp=20251008150702575

# Run evaluation on all benchmarks (default behavior)
pnpm run eval

# Run evaluation with specific parameters
pnpm run gen-benchmark --startTimeOffset=1 --endTimeOffset=2 --meetingLength=60 --nSimUsers=3 --nGroups=2
pnpm run eval --benchmarkSet=benchmarks --nReps=3

# Generate one-liner test cases
pnpm run oneliners

# Run one-liner evaluation on specific file
pnpm run oneliners --filename=benchmark_2simusers_1start_2end_60min_gen20250922201028577_eval20250923135910404_topic.json
```

## Benchmark Generation (`gen-benchmark.ts`)

Creates realistic scheduling scenarios with AI-generated calendar events.

### Usage

```bash
# Basic usage with defaults (creates new folder)
pnpm run gen-benchmark

# With command line arguments
pnpm run gen-benchmark --startTimeOffset=1.5 --endTimeOffset=3 --meetingLength=90 --nSimUsers=4 --nGroups=3

# Add to existing generation batch (appends to existing folder)
pnpm run gen-benchmark --genTimestamp=20251008150702575 --nSimUsers=4

# Generate multiple groups in one command
pnpm run gen-benchmark --nGroups=3 --nSimUsers=6
```

### Parameters

- `--startTimeOffset` / `-s`: Days offset from Jan 1, 2025 midnight EST for benchmark start (supports decimals, default: 1)
- `--endTimeOffset` / `-e`: Days offset from Jan 1, 2025 midnight EST for benchmark end (supports decimals, default: 2)
- `--meetingLength` / `-l`: Meeting duration in minutes (default: 60)
- `--nSimUsers` / `-a`: Number of simulated users to create (default: 2)
- `--nGroups` / `-g`: Number of groups to divide users into (default: 1)
- `--genTimestamp` / `-t`: Use existing generation timestamp (appends to existing folder)

### Features

- **Fractional day offsets**: Use values like `1.5` for 36-hour periods
- **Realistic calendars**: AI-generated events based on random professions and industries
- **Timezone consistency**: All times use Eastern Time (EST/EDT) with proper UTC storage
- **Organized output**: Creates timestamped files in structured folders
- **Event validation**: Ensures generated events fall within specified time ranges

### Output Structure

```
src/evals/data/benchmarks/
├── benchmark_2simusers_1start_2end_60min_gen20251008150702575/
│   ├── benchmark_2simusers_1start_2end_60min_group1_gen20251008150702575.json
│   ├── benchmark_2simusers_1start_2end_60min_group2_gen20251008150702575.json
│   └── benchmark_4simusers_1start_2end_60min_group3_gen20251008150702575.json
├── benchmark_4simusers_1-5start_3end_90min_gen20251008150745123/
│   ├── benchmark_4simusers_1-5start_3end_90min_group1_gen20251008150745123.json
│   └── benchmark_6simusers_1-5start_3end_90min_group2_gen20251008150745123.json
└── benchmark_3simusers_2start_4end_30min_gen20251008150800456/
    └── benchmark_3simusers_2start_4end_30min_group1_gen20251008150800456.json
```

### Folder Structure Logic

- **New generation**: Creates folder `benchmark_X_gen<timestamp>` in `benchmarks/` directory
- **Existing generation**: When using `--genTimestamp`, finds any folder ending with `_gen<timestamp>` and appends new files
- **Group numbering**: Files are numbered sequentially (`group1`, `group2`, etc.) based on existing files in the folder
- **Parameter flexibility**: Can add files with different parameters to the same generation batch using the timestamp

## Evaluation (`simple-flack-eval.ts`)

Simulates scheduling conversations and evaluates bot performance.

### Usage

```bash
# Run all benchmarks in the benchmarks folder (default)
pnpm run eval

# Run all benchmarks in a specific benchmark set
pnpm run eval --benchmarkSet=benchmarks

# Run all benchmarks in a custom benchmark set folder
pnpm run eval --benchmarkSet=my_custom_benchmarks

# Run a single specific benchmark folder
pnpm run eval --benchmark=benchmark_2simusers_1start_2end_60min_gen20251008150702575

# Run multiple repetitions for statistical analysis
pnpm run eval --benchmarkSet=benchmarks --nReps=5

# Enable topic routing
pnpm run eval --benchmarkSet=benchmarks --topicRouting
```

### Parameters

- `--benchmarkSet` / `-s`: Top-level folder containing multiple benchmarks (default: "benchmarks")
- `--benchmark` / `-b`: Single benchmark folder with timestamped groups
- `--nReps` / `-r`: Number of repetitions to run for each benchmark case (default: 1)
- `--topicRouting` / `-t`: Enable topic routing (default: false)

### Benchmark Set vs Single Benchmark

- **Benchmark Set**: Runs all benchmark folders within a top-level directory (e.g., all folders in `benchmarks/`)
- **Single Benchmark**: Runs all files within a specific timestamped benchmark folder

### Features

- **Conversation simulation**: AI simulated users (simUsers) with realistic personas and goals
- **Multi-metric evaluation**: Success rate, confirmation rate, feasibility analysis
- **Common availability check**: Uses `findCommonFreeTime` to verify actual scheduling feasibility
- **Timezone-aware logging**: All times displayed in Eastern Time
- **Statistical aggregation**: Multiple repetitions with summary statistics
- **Detailed results**: Individual agent responses, conflicts, and timing analysis

### Output Structure

```
src/evals/results/
├── benchmark_2simusers_1start_2end_60min/
│   └── gen20251008150702575/
│       ├── eval20251008151045123/
│       │   ├── eval_results.json
│       │   ├── benchmark_2simusers_1start_2end_60min_eval20251008151045123_group0_topic.json
│       │   └── benchmark_2simusers_1start_2end_60min_eval20251008151045123_group1_topic.json
│       └── eval20251008151100456/
│           └── eval_results.json
└── benchmark_4simusers_1-5start_3end_90min/
    └── gen20251008150745123/
        └── eval20251008151200789/
            ├── eval_results.json
            └── benchmark_4simusers_1-5start_3end_90min_eval20251008151200789_group0_topic.json
```

### Evaluation Metrics

- **Success Rate**: Percentage of cases with confirmed meetings
- **Confirmation Rate**: Agent confirmation response accuracy  
- **Feasibility Rate**: Meetings scheduled during actual free time
- **Max Shared Free Time**: Longest common availability window (minutes)
- **Time Constraint Compliance**: Meetings within benchmark time range

## Complete Workflow Examples

### Example 1: Basic Generation and Evaluation

```bash
# 1. Generate initial benchmark set
pnpm run gen-benchmark --nSimUsers=3 --nGroups=2 --meetingLength=60
# Creates: benchmarks/benchmark_3simusers_1start_2end_60min_gen20251008150702575/
#   - benchmark_3simusers_1start_2end_60min_group1_gen20251008150702575.json
#   - benchmark_3simusers_1start_2end_60min_group2_gen20251008150702575.json

# 2. Run evaluation on all benchmarks
pnpm run eval
# Evaluates all folders in benchmarks/ directory
```

### Example 2: Iterative Benchmark Development

```bash
# 1. Create initial batch with specific parameters
pnpm run gen-benchmark --nSimUsers=4 --meetingLength=90 --startTimeOffset=1.5
# Output: Generated timestamp 20251008151000123

# 2. Add more cases to the same batch (different user counts, same timestamp)
pnpm run gen-benchmark --genTimestamp=20251008151000123 --nSimUsers=2
pnpm run gen-benchmark --genTimestamp=20251008151000123 --nSimUsers=6

# 3. Add cases with different parameters to the same batch
pnpm run gen-benchmark --genTimestamp=20251008151000123 --meetingLength=30 --nSimUsers=3

# Result: All files in same folder, numbered sequentially:
#   - benchmark_4simusers_1-5start_2end_90min_group1_gen20251008151000123.json
#   - benchmark_2simusers_1-5start_2end_90min_group2_gen20251008151000123.json
#   - benchmark_6simusers_1-5start_2end_90min_group3_gen20251008151000123.json
#   - benchmark_3simusers_1-5start_2end_30min_group4_gen20251008151000123.json

# 4. Evaluate the specific batch
pnpm run eval --benchmark=benchmark_4simusers_1-5start_2end_90min_gen20251008151000123
```

### Example 3: Statistical Analysis with Multiple Repetitions

```bash
# 1. Generate diverse benchmark set
pnpm run gen-benchmark --nGroups=3 --nSimUsers=3
pnpm run gen-benchmark --nGroups=2 --nSimUsers=4 --meetingLength=120

# 2. Run comprehensive evaluation with repetitions
pnpm run eval --benchmarkSet=benchmarks --nReps=5 --topicRouting

# 3. Results include statistical summaries across all repetitions
```

## Architecture

### Agent System

- **BaseScheduleUser**: Core agent class with calendar, goals, and conversation history
- **GenerateReplyAgent**: AI-powered response generation using conversation context
- **SendInitialMessageAgent**: Creates realistic initial scheduling requests
- **ConfirmationCheckAgent**: Detects meeting confirmations in responses
- **TimeExtractionAgent**: Extracts suggested meeting times from messages

### Calendar Generation

- **genFakeCalendar**: AI-generated realistic calendar events
- **Profession-based**: Random selection from diverse professions and industries
- **Timezone-aware**: Consistent Eastern Time handling throughout

### Time Intersection

- **findCommonFreeTime**: Multi-person availability calculation
- **Conflict detection**: Individual agent calendar checking
- **Feasibility validation**: Ensures suggested times are actually possible

## Prerequisites

Ensure the following environment variables, including  ```PV_OPENROUTER_API_KEY``` and ```PV_DB_URL```.

The flack server should be running for evaluation:

```bash
# In another terminal
pnpm run local
```

## Development

The evaluation framework uses:
- **TypeScript**: Strict typing for reliability
- **AI Agents**: Claude Sonnet 4 via OpenRouter for realistic simulation
- **Date handling**: Native JavaScript Date objects with timezone awareness
- **File organization**: Structured results with timestamps and metadata

For debugging, all tools provide detailed console output showing agent interactions, calendar conflicts, and scheduling decisions.

## One-liner Evaluation (`oneline_evals.ts`)

Evaluates bot behavior on single-turn conversations by replaying specific messages from topic dumps.

### Preparation

This evaluation method relies on having dumped a topic that contains the conversation that you want to use as a test. Dump topic is automatically called during evaluation simulations, generating a ```.json``` file. Alternately, with the topic id, you can call ```pnpm dump topic <topicId> -o <filename.json>```, in which case the dumpTopic data gets saved to a file with the specified name. In the web app, when you are on a topic page, you can read the topic id out of the URL (the string after ```topic/``` and before ```?message=```).

From there, you need to copy over the ```.json``` file to ```src/evals/data/oneliners```. You need to manually add two additional fields to the file. First, ```loadUpToId``` which contains the final user-sent message ID that you want to resend to the agent for the test. The script will automatically load all of the information from the database that occured up to the point in time when the message was initially sent, restoring the database state, and then finally resends the message to the agent. Usually, you will want this message to be the one in response to which Pivotal generated unexpected behavior. The message ID can be found in the json file by scrolling down to the message of interest (labeled "Id"), or else is also listed in the web app.

Second, to automatically evaluate Pivotal behavior, you can optionally also include a textual behavior of what you expect Pivotal to do in a new ```expectedBehavior``` field.

### Usage

You can use command line arguments to run all tests at once or run only the test in a specific file. Optionally, you can specify to repeat each file a number of times.

```bash
# Run evaluation on all files in oneliners directory
pnpm run oneliners

# Run evaluation on a specific file
pnpm run oneliners --filename=benchmark_2simusers_1start_2end_60min_gen20250922201028577_eval20250923135910404_topic.json

# Run with multiple repetitions for statistical reliability
pnpm run oneliners --nReps=5

# Run specific file with repetitions
pnpm run oneliners --filename=test.json --nReps=3

# Show help
pnpm run oneliners --help
```

### Parameters

- `--filename` / `-f`: Specific topic JSON filename to evaluate (must be in `src/evals/data/oneliners/`)
- `--nReps` / `-n`: Number of times to repeat each test (default: 1)
- `--help` / `-h`: Show help message and exit

### Features

- **Message replay**: Loads topic context up to a specific message, then resends that message
- **Behavior validation**: Compares bot responses against expected behavior using AI evaluation
- **Repetition testing**: Run each test multiple times with `--nReps` for statistical reliability
- **Batch processing**: Evaluates all files in oneliners directory when no filename specified
- **File-level statistics**: Categorizes files as having only successes, failures, errors, or no expected behavior
- **Database isolation**: Clears database before each evaluation for consistent results

### Repetition Analysis

When using `--nReps > 1`, the tool provides detailed statistics:

- **Single file mode**: Shows repetition summary with success rate across all runs
- **Batch mode**: Categorizes each file based on outcomes across all repetitions:
  - Files with only successes (all repetitions passed)
  - Files with failures (at least one repetition failed)
  - Files without expected behavior (all repetitions skipped)
  - Files with errors (script execution failed)

This is useful for identifying:
- **Consistent reliability**: Files that always pass or always fail
- **Intermittent issues**: Files that sometimes fail (non-deterministic behavior)
- **Test coverage**: Files missing expected behavior specifications

### Expected File Format

JSON files in `src/evals/data/oneliners/` should contain:
- `loadUpToId`: Message ID to replay (conversation context loaded up to this point)
- `expectedBehavior`: Expected bot behavior description for evaluation
- Standard topic dump format with messages, states, etc.