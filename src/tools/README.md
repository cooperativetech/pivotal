# Overview
This directory contains TypeScript-based tools designed to be called by an LLM assistant for scheduling tasks.

## Tools Available

### `time_intersection.ts`
A scheduling algorithm to find common free time intervals between multiple user calendars.

### `json_extractor.ts`
Converts LLM reasoning/analysis text into structured JSON format for API responses. Used when the LLM provides good analysis but in the wrong format.

## Time Intersection Logic
The core scheduling algorithm logic:  
1) For each user, determine their busy times. 
2) Invert the busy times to find free times. 
3) Find intersection of all user free times. 

This approach is simple, modular, and efficient, similar to the functionality in Google Calendar's "Find a Time" feature.

# Logic
The scheduling pipeline is composed of several key functions:
1) `normalizeCalendars()`: Takes a list of user profiles and their raw calendar events. For each user, it merges any overlapping or adjacent busy intervals into a clean, sorted list.
2) `invert()`: Takes a user's merged busy intervals and subtracts them from a full-day window, producing a list of their available (free) time slots.
3) `intersect()`: Takes two lists of free time intervals and returns a new list containing only the times that overlap. This is used iteratively to find the common availability across all users.
4) `getAcceptableTimes()`: Filters the final list of common free slots to ensure they fall within a reasonable time window (e.g., not at 3 AM). This can be made more general, i.e., by including a ranking function for each time.
5) `findCommonFreeTime()`: The entire pipeline is exported through this main function, calling the functions above to produce the final list of available slots.

# Down the line
- additional checks / robustness on calendar format. i.e., check everyone in same timezone? if not, convert. 
- currently the 'filter' step is fairly simple. it's just acceptable times. eventually this will do a more sophisticated ranking and be integrated with some LLM comprehension for the best time given the context in chat. 
    - even for acceptable times, can obtain from users / infer from their calendars then take global intersection of acceptable times as filter.
- currently goes day at a time. expand this into weeks / larger blocks. 
    - add comprehension for recurring events
- comprehension for soft vs. hard blocks (i.e., nap time vs. meeting the in-laws)