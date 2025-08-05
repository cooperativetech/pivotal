import json
from time_intersection import normalize_calendars, find_common_free, get_acceptable_times

2+2

# Load calendars from eval json
with open("../evals/data/benchmark-data-100-cases.json") as f:
    data = json.load(f)

# Pick a single case
case = data[0]

# Filter for selected users
selected_names = {"Alice", "Bob", "Charlie"}
profiles = [p for p in case["profiles"] if p["name"] in selected_names]

# Run your pipeline
busy_map = normalize_calendars(profiles)
common_free = find_common_free(busy_map)
slots = get_acceptable_times(common_free)

# Print output
print(f"Free slots for {', '.join(selected_names)} in case {case['id']}:")
for s, e in slots:
    print(f"{s.time()} → {e.time()}")
