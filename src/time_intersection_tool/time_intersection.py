"""
scheduler_pipeline.py

Core pipeline for multi-person free-time intersection:

1) normalize_calendars: parse user calendars into merged busy intervals
2) find_common_free: invert + intersect to get common free intervals
3) get_acceptable_times: filter/rank the free intervals (set parameters below)

Assumes all events fall on the same date, and window provides that date context.
"""
from datetime import datetime, time, timedelta
from typing import List, Tuple, Dict
from functools import reduce

# Type alias for clarity
datetimeInterval = Tuple[datetime, datetime]

#------------------------
# Global vars: User-configurable filter
#------------------------
# Define acceptable hours here, datetime format. For use in `get_acceptable_times()`.
ACCEPTABLE_START: time = time(6, 0)
ACCEPTABLE_END:   time = time(22, 0)

#------------------------
# Interval primitives
#------------------------

def merge(intervals: List[datetimeInterval]) -> List[datetimeInterval]:
    """Merge overlapping intervals into a sorted, non-overlapping list."""
    if not intervals:
        return []
    intervals.sort(key=lambda x: x[0])
    merged = [list(intervals[0])]
    for start, end in intervals[1:]:
        last = merged[-1]
        if start <= last[1]:
            last[1] = max(last[1], end)
        else:
            merged.append([start, end])
    return [(s, e) for s, e in merged]


def invert(busy: List[datetimeInterval], window: datetimeInterval) -> List[datetimeInterval]:
    """Subtract busy intervals from window to get free intervals."""
    free: List[datetimeInterval] = []
    cursor = window[0]
    for start, end in busy:
        if cursor < start:
            free.append((cursor, start))
        cursor = max(cursor, end)
    if cursor < window[1]:
        free.append((cursor, window[1]))
    return free


def intersect(a: List[datetimeInterval], b: List[datetimeInterval]) -> List[datetimeInterval]:
    """Intersect two lists of intervals."""
    i = j = 0
    out: List[datetimeInterval] = []
    while i < len(a) and j < len(b):
        start = max(a[i][0], b[j][0])
        end   = min(a[i][1], b[j][1])
        if start < end:
            out.append((start, end))
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return out

#------------------------
# Pipeline functions
#------------------------

def normalize_calendars(
    profiles: List[Dict]
) -> Dict[str, List[datetimeInterval]]:
    """
    Convert raw JSON profiles to a map of user -> merged busy intervals.
    As per parker's eval, expects each profile {'name': str, 'calendar': [{'start': 'HH:MM','end': 'HH:MM', ...}, ...]}.
    All events are mapped onto window[0].date().
    """
    busy_map: Dict[str, List[datetimeInterval]] = {}
    for p in profiles:
        name = p['name']
        raw = []
        for ev in p.get('calendar', []):
            date = datetime.today().date() # datetime operations require a date context. will be useful later too.
            st = datetime.combine(date, datetime.strptime(ev['start'], '%H:%M').time())
            en = datetime.combine(date, datetime.strptime(ev['end'],   '%H:%M').time())
            raw.append((st, en))
        busy_map[name] = merge(raw)
    return busy_map


def find_common_free(
    busy_map: Dict[str, List[datetimeInterval]]
) -> List[datetimeInterval]:
    """
    Compute common free intervals across all users in busy_map.
    """
    date = datetime.today().date()
    window = (
        datetime.combine(date, time(0, 0)),
        datetime.combine(date, time(23, 59))
    )
    free_lists = [invert(busy, window) for busy in busy_map.values()]
    return reduce(intersect, free_lists) if free_lists else []


def get_acceptable_times(
    common_free: List[datetimeInterval],
    start: time = ACCEPTABLE_START,
    end: time = ACCEPTABLE_END
) -> List[datetimeInterval]:
    """
    Placeholder: filter or rank 'common_free' intervals.
    Currently returns the full list unchanged.
    """
    acceptable: List[datetimeInterval] = []
    for start_time, end_time in common_free:
        if start_time.time() >= start and end_time.time() <= end:
            acceptable.append((start_time, end_time))  
    return acceptable

# Example usage
def example():
    # Sample profiles
    profiles = [
        {'name':'Alice', 'calendar':[{'start':'12:00','end':'13:00'}, {'start':'14:00','end':'15:00'}]},
        {'name':'Bob',   'calendar':[{'start':'09:00','end':'13:00'}]}
    ]

    busy_map = normalize_calendars(profiles)
    common_free = find_common_free(busy_map)
    slots = get_acceptable_times(common_free)
    for s,e in slots:
        print(f"Free: {s.time()} → {e.time()}")

if __name__ == '__main__':
    example()