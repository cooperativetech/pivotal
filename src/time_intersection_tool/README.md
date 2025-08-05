# Overview
This is a tool that is called by the pivotal LLM scheduler to find intersections between user calendars.

The calendar problem is not new. The tool follows simple logic of "obtain free times per person + take intersection". Intervals of free time are lists, code designed to be as simple and modular as possible and can handle very high throughput as we scale. Google's 'Find a Time' feature works similarly.  

# Logic
1) For each user, turn calendars into intervals of busy times.
    → `normalize_calendars()` (uses `merge()` in the function to massage overlapping busys)
2) Take the complement of busy times. These are free times. 
    → `invert()` (called inside `find_common_free()`)
3) Find the intersection of all free times. These are globally all the possible times for the calendar event.
    → `intersect()` (also inside `find_common_free()`)
4) Filter all possible times for 'acceptable' times. 
    → `get_acceptable_times()`

# Down the line
- additional checks / robustness on calendar format. i.e., check everyone in same timezone? if not, convert. 
- currently the 'filter' step is fairly simple. it's just acceptable times. eventually this will do a more sophisticated ranking and be integrated with some LLM comprehension for the best time given the context in chat. 
    - even for acceptable times, can obtain from users / infer from their calendars then take global intersection of acceptable times as filter.
- currently goes day at a time. expand this into weeks / larger blocks. 
    - add comprehension for recurring events
- comprehension for soft vs. hard blocks (i.e., nap time vs. meeting the in-laws)