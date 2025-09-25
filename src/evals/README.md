# Scheduling Evaluation Framework

This directory contains tools for evaluating AI-assisted scheduling performance through automated benchmark generation and conversation simulation.

## Quick Start

```bash
# Generate benchmark data
pnpm run gen-benchmark

# Run evaluation on the generated benchmark
pnpm run eval

# Run evaluation with specific parameters
pnpm run gen-benchmark --startTimeOffset=1 --endTimeOffset=2 --meetingLength=60 --nSimUsers=3 --nCases=5
pnpm run eval --benchmarkFolder=benchmark_3simusers_1start_2end_60min --nReps=3

# Generate one-liner test cases
pnpm run oneliners

# Run one-liner evaluation on specific file
pnpm run oneliners --filename=benchmark_2simusers_1start_2end_60min_gen20250922201028577_eval20250923135910404_topic.json
```

## Benchmark Generation (`gen-benchmark.ts`)

Creates realistic scheduling scenarios with AI-generated calendar events.

### Usage

```bash
# Basic usage with defaults
pnpm run gen-benchmark

# With command line arguments
pnpm run gen-benchmark --startTimeOffset=1.5 --endTimeOffset=3 --meetingLength=90 --nSimUsers=4 --nCases=10

# Positional arguments (backwards compatibility)
pnpm run gen-benchmark 1 2 60 3 5
```

### Parameters

- `--startTimeOffset` / `--start`: Days offset from Jan 1, 2025 midnight EST for benchmark start (supports decimals, default: 1)
- `--endTimeOffset` / `--end`: Days offset from Jan 1, 2025 midnight EST for benchmark end (supports decimals, default: 2)  
- `--meetingLength` / `--length`: Meeting duration in minutes (default: 60)
- `--nSimUsers` / `-a`: Number of simulated users to create (default: 2)
- `--nCases` / `--cases`: Number of benchmark cases to generate (default: 1)

### Features

- **Fractional day offsets**: Use values like `1.5` for 36-hour periods
- **Realistic calendars**: AI-generated events based on random professions and industries
- **Timezone consistency**: All times use Eastern Time (EST/EDT) with proper UTC storage
- **Organized output**: Creates timestamped files in structured folders
- **Event validation**: Ensures generated events fall within specified time ranges

### Output Structure

```
src/evals/data/
├── benchmark_2simusers_1start_2end_60min/
│   ├── benchmark_2simusers_1start_2end_60min_gen20250915121553773.json
│   └── benchmark_2simusers_1start_2end_60min_gen20250915121601234.json
└── benchmark_3simusers_1-5start_3end_90min/
    └── benchmark_3simusers_1-5start_3end_90min_gen20250915122034567.json
```

**Note**: Folder naming convention changed from `agents` to `simusers` for clarity. Existing folders with `agents` naming are still supported.

## Evaluation (`simple-flack-eval.ts`)

Simulates scheduling conversations and evaluates bot performance.

### Usage

```bash
# Run on a specific benchmark file
pnpm run eval --benchmarkFile=benchmark_2simusers_1start_2end_60min_gen20250915121553773.json

# Run on all benchmarks in a folder
pnpm run eval --benchmarkFolder=benchmark_2simusers_1start_2end_60min

# Run multiple repetitions for statistical analysis
pnpm run eval --benchmarkFolder=benchmark_2simusers_1start_2end_60min --nReps=5

# Default behavior (if no arguments specified)
pnpm run eval  # Uses default folder: benchmark_2simusers_1start_2end_60min
```

**Note**: Use `--benchmarkFile` for a specific JSON file, or `--benchmarkFolder` to run all benchmarks in a directory.

```

### Parameters

- `benchmarkFile`: Benchmark file name or folder name to evaluate
- `--nReps`: Number of repetitions to run for each benchmark case (default: 1)

### File vs Folder Detection

The tool automatically detects whether you're specifying a file or folder:
- **File**: Contains `gen` followed by 17 digits (timestamp pattern)
- **Folder**: Any other string (evaluates all benchmarks in that folder)

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
│   ├── gen20250915121553773/
│   │   ├── eval20250915123045123_rep1.json
│   │   ├── eval20250915123047456_rep2.json
│   │   └── summary_20250915123050789.json
│   └── gen20250915121601234/
│       └── eval20250915123055123_rep1.json
```

### Evaluation Metrics

- **Success Rate**: Percentage of cases with confirmed meetings
- **Confirmation Rate**: Agent confirmation response accuracy  
- **Feasibility Rate**: Meetings scheduled during actual free time
- **Max Shared Free Time**: Longest common availability window (minutes)
- **Time Constraint Compliance**: Meetings within benchmark time range

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

This evaluation method relies on having dumped a topic that contains the conversation that you want to use as a test. Dump topic is automatically called during evaluation simulations, generating a ```.json``` file. Alternately, with the topic id, you can call ```pnpm dump topic --topicId``` to dump the relevant topic to a ```.json``` manually.

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